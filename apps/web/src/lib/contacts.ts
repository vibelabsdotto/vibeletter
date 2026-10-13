import { randomBytes } from "node:crypto";
import { and, asc, count, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db, connectDb } from "@/db";
import { contacts, newsletters, suppressions, type Newsletter } from "@/db/schema";
import { normalizeEmail } from "./validation.js";

// Counts only the matching indexed contacts and keeps one result per newsletter.
export async function listNewslettersWithActiveCounts(fields?: string) {
  await connectDb();
  const allColumns = getTableColumns(newsletters);
  const selected = fields
    ? Object.fromEntries(["_id", ...fields.split(/\s+/)].filter(key => key in allColumns).map(key => [key, allColumns[key as keyof typeof allColumns]]))
    : allColumns;
  return db.select({
    ...selected,
    activeCount: count(contacts._id),
  }).from(newsletters)
    .leftJoin(contacts, and(eq(contacts.newsletterId, newsletters._id), eq(contacts.status, "active")))
    .groupBy(newsletters._id).orderBy(asc(newsletters.createdAt)).all();
}

const suppressedStatuses = { bounce: "bounced", complaint: "complained", manual: "unsubscribed" } as const;
const reactivatable = ["unsubscribed", "dormant"] as const;
const engagement = (now: Date) => ({
  ignoredIssues: 0,
  lastEngagedAt: sql`max(coalesce(${contacts.lastEngagedAt}, 0), ${now.getTime()})`,
  updatedAt: now,
});
type Reference = { contactId: string; newsletterId: string };
type ConfirmationReference = Reference & { confirmationNonce: string };
const newConfirmationNonce = () => randomBytes(16).toString("hex");

export async function upsertContact({ newsletter, email, source, resubscribe, requireResubscriptionConfirmation = false }: {
  newsletter: Pick<Newsletter, "_id" | "requireConfirmation">;
  email: string;
  source?: string;
  resubscribe?: boolean;
  requireResubscriptionConfirmation?: boolean;
}) {
  await connectDb();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error("A valid email address is required");
  return db.transaction(tx => {
    const now = new Date();
    const suppression = tx.select().from(suppressions).where(eq(suppressions.email, normalizedEmail)).get();
    const joinStatus = newsletter.requireConfirmation ? "pending" : "active";
    const status = suppression ? suppressedStatuses[suppression.reason] : joinStatus;
    const where = and(eq(contacts.newsletterId, newsletter._id), eq(contacts.email, normalizedEmail));
    const inserted = tx.insert(contacts).values({
      newsletterId: newsletter._id, email: normalizedEmail, status, source, subscribedAt: now,
      confirmationNonce: status === "pending" ? newConfirmationNonce() : null,
      imported: { subscribedAtKnown: true },
    }).onConflictDoNothing({ target: [contacts.newsletterId, contacts.email] }).returning().get();
    if (inserted) return { contact: inserted, created: true };
    let contact = tx.select().from(contacts).where(where).get();
    if (!contact) throw new Error("Could not read back contact");
    if (!resubscribe || suppression) return { contact, created: false };
    if (contact.status === "active") {
      contact = tx.update(contacts).set(engagement(now)).where(eq(contacts._id, contact._id)).returning().get() ?? contact;
    } else if (reactivatable.includes(contact.status as typeof reactivatable[number])) {
      // An anonymous email submission cannot reverse a recipient's explicit opt-out.
      const nextStatus = requireResubscriptionConfirmation && contact.status === "unsubscribed" ? "pending" : joinStatus;
      contact = tx.update(contacts).set({
        ...engagement(now), status: nextStatus, subscribedAt: now, unsubscribedAt: null, confirmedAt: null,
        confirmationNonce: nextStatus === "pending" ? newConfirmationNonce() : null,
        imported: sql`json_set(coalesce(${contacts.imported}, '{}'), '$.subscribedAtKnown', json('true'))`,
      }).where(and(eq(contacts._id, contact._id), inArray(contacts.status, [...reactivatable]))).returning().get() ?? contact;
    } else if (contact.status === "pending" && !contact.confirmationNonce) {
      // Legacy pending rows need a new recipient-bound link, not a usable old confirmation.
      contact = tx.update(contacts).set({ confirmationNonce: newConfirmationNonce(), confirmedAt: null, subscribedAt: now, updatedAt: now,
        imported: sql`json_set(coalesce(${contacts.imported}, '{}'), '$.subscribedAtKnown', json('true'))` })
        .where(and(eq(contacts._id, contact._id), eq(contacts.status, "pending"))).returning().get() ?? contact;
    }
    return { contact, created: false };
  }, { behavior: "immediate" });
}

export async function confirmContact({ contactId, newsletterId, confirmationNonce }: ConfirmationReference) {
  await connectDb();
  return db.transaction(tx => {
    const reference = and(eq(contacts._id, contactId), eq(contacts.newsletterId, newsletterId));
    const existing = tx.select().from(contacts).where(reference).get();
    if (!confirmationNonce || !existing || existing.confirmationNonce !== confirmationNonce ||
      tx.select({ value: count() }).from(suppressions).where(eq(suppressions.email, existing.email)).get()?.value) {
      return { contact: null, confirmed: false };
    }
    const now = new Date();
    const contact = tx.update(contacts).set({ ...engagement(now), status: "active", confirmedAt: now })
      .where(and(reference, eq(contacts.status, "pending"), eq(contacts.confirmationNonce, confirmationNonce))).returning().get();
    return { contact: contact ?? existing, confirmed: !!contact };
  }, { behavior: "immediate" });
}

export async function keepContact({ contactId, newsletterId }: Reference) {
  await connectDb();
  return db.transaction(tx => {
    const reference = and(eq(contacts._id, contactId), eq(contacts.newsletterId, newsletterId));
    const existing = tx.select().from(contacts).where(reference).get();
    if (!existing || !["active", "dormant"].includes(existing.status)) return null;
    if (tx.select({ _id: suppressions._id }).from(suppressions).where(eq(suppressions.email, existing.email)).get()) return null;
    const now = new Date();
    return tx.update(contacts).set({ ...engagement(now), status: "active" })
      .where(and(reference, inArray(contacts.status, ["active", "dormant"]))).returning().get() ?? null;
  }, { behavior: "immediate" });
}
