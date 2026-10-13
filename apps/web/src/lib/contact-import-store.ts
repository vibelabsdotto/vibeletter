import { and, eq, sql } from "drizzle-orm";
import { db, connectDb } from "@/db";
import { contacts, suppressions, type Contact } from "@/db/schema";
import { STATUS_RANK, sanitizeImportRow } from "./csv-import.js";

type ImportedStatus = keyof typeof STATUS_RANK;
type ImportRow = {
  email: string; status: ImportedStatus; subscribedAt?: Date;
  emailsReceived?: number; openRate?: number; clickRate?: number;
};
const rank = (status: Contact["status"]): number | undefined => status === "pending" ? STATUS_RANK.dormant : STATUS_RANK[status as ImportedStatus];
const suppressionStatus = { bounce: "bounced", complaint: "complained", manual: "unsubscribed" } as const;

// A transaction holds the write reservation while imports, signup and SES feedback can contend.
export async function importContactRows({ newsletterId, rows, source = "import" }: {
  newsletterId: string; rows: unknown[]; source?: string;
}) {
  await connectDb();
  const unique = new Map<string, ImportRow>();
  for (const input of rows) {
    const row = sanitizeImportRow(input) as ImportRow | null;
    if (!row) continue;
    const previous = unique.get(row.email);
    // Repeated CSV rows cannot erase an opt-out recorded earlier in that same request.
    unique.set(row.email, previous && STATUS_RANK[previous.status] > STATUS_RANK[row.status]
      ? { ...row, status: previous.status }
      : row);
  }
  if (!unique.size) return { created: 0, existing: 0, invalid: rows.length };
  return db.transaction(tx => {
    const now = new Date();
    let created = 0;
    let existing = 0;
    for (const row of unique.values()) {
      const reason = row.status === "complained" ? "complaint" : row.status === "bounced" ? "bounce" : null;
      let suppression = tx.select().from(suppressions).where(eq(suppressions.email, row.email)).get();
      if (reason) {
        if (!suppression) {
          suppression = tx.insert(suppressions).values({ email: row.email, reason, detail: source })
            .returning().get();
        } else if (suppression.reason !== "complaint" && suppression.reason !== reason) {
          suppression = tx.update(suppressions).set({ reason, detail: source, updatedAt: now })
            .where(eq(suppressions._id, suppression._id)).returning().get();
        }
      }
      const status = suppression && STATUS_RANK[suppressionStatus[suppression.reason]] > STATUS_RANK[row.status]
        ? suppressionStatus[suppression.reason]
        : row.status;
      const imported = Object.fromEntries(Object.entries({
        emailsReceived: row.emailsReceived, openRate: row.openRate, clickRate: row.clickRate,
      }).filter(([, value]) => value !== undefined));
      const hasImported = Object.keys(imported).length > 0;
      const contactWhere = and(eq(contacts.newsletterId, newsletterId), eq(contacts.email, row.email));
      const old = tx.select().from(contacts).where(contactWhere).get();
      if (!old) {
        const inserted = tx.insert(contacts).values({
          newsletterId, email: row.email, status, source,
          subscribedAt: row.subscribedAt ?? now,
          unsubscribedAt: status === "unsubscribed" ? now : null,
          // Source labels are editable; the provenance of the join date is not.
          imported: { ...imported, subscribedAtKnown: row.subscribedAt !== undefined },
        }).returning().get();
        if (!inserted) throw new Error("Could not read back imported contact");
        created++;
      } else {
        const previousRank = rank(old.status);
        const nextStatus = previousRank !== undefined && STATUS_RANK[status] > previousRank ? status : old.status;
        tx.update(contacts).set({
          ...(nextStatus !== old.status ? { status: nextStatus, confirmationNonce: null, ...(nextStatus === "unsubscribed" ? { unsubscribedAt: now } : {}) } : {}),
          ...(hasImported ? { imported: sql`json_patch(coalesce(${contacts.imported}, '{}'), ${JSON.stringify(imported)})` } : {}),
          updatedAt: now,
        }).where(eq(contacts._id, old._id)).run();
        existing++;
      }
      if (suppression && suppression.reason !== "manual") {
        const blocked = suppressionStatus[suppression.reason];
        tx.update(contacts).set({ status: blocked, confirmationNonce: null, updatedAt: now })
          .where(and(eq(contacts.email, row.email), suppression.reason === "complaint"
            ? sql`${contacts.status} <> 'complained'`
            : sql`${contacts.status} not in ('complained', 'bounced')`)).run();
      }
      if (!tx.select({ _id: contacts._id }).from(contacts).where(contactWhere).get()) {
        throw new Error("Could not read back imported contact");
      }
    }
    return { created, existing, invalid: rows.length - unique.size };
  }, { behavior: "immediate" });
}
