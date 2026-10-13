import "server-only";
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { connectDb, db } from "@/db";
import { newsletters, contacts, campaigns, messages, suppressions } from "@/db/schema";
import { upsertContact } from "@/lib/contacts";
import { importContactRows } from "@/lib/contact-import";
import { getInbox } from "@/lib/inbox-links";
import { normalizeEmail, MAX_BODY_BYTES } from "@/lib/validation";
import { CLEANUP_LIMITS } from "@/lib/cleanup";
import { getConfirmationProblem } from "@/lib/confirmation-content";
import {
  assertKnownFields, expectObject, OperatorError, parseId, readBoolean, readDate,
  readInteger, readString, type OperatorBody, type OperatorPage,
} from "@/lib/operator-api";

export type StoredNewsletter = typeof newsletters.$inferSelect;
export type StoredContact = typeof contacts.$inferSelect;
export const CONTACT_STATUSES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"] as const;
const NEWSLETTER_FIELDS = ["name", "slug", "fromName", "fromEmail", "replyTo", "postalAddress", "imageUrl", "archiveEnabled", "description", "socialLinks", "author", "requireConfirmation", "cleanup", "welcome", "confirmation"];
const NEWSLETTER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export function operatorId(): string { return randomBytes(12).toString("hex"); }

export function readEmail(value: unknown, field = "email"): string {
  const email = normalizeEmail(value);
  if (!email) throw new OperatorError(400, "invalid_email", `${field} is invalid`);
  return email;
}

function readImage(value: unknown, field: string): string {
  const image = readString(value, field, { required: false, max: 2048 }) ?? "";
  if (image && !/^\/(?!\/)[^\s]*$/.test(image)) {
    let url: URL;
    try { url = new URL(image); } catch { throw new OperatorError(400, "invalid_url", `${field} must be an HTTPS URL or local path`); }
    if (url.protocol !== "https:" || url.username || url.password) throw new OperatorError(400, "invalid_url", `${field} must be an HTTPS URL or local path`);
  }
  return image;
}

export function newsletterBySlug(value: unknown): StoredNewsletter {
  const slug = readString(value, "newsletter", { required: true, max: 40, trim: false });
  if (!slug || !NEWSLETTER_SLUG_PATTERN.test(slug)) throw new OperatorError(400, "invalid_newsletter", "newsletter must be a lowercase slug of at most 40 characters, without a trailing hyphen");
  const newsletter = db.select().from(newsletters).where(eq(newsletters.slug, slug)).get();
  if (!newsletter) throw new OperatorError(404, "not_found", "Newsletter not found");
  return newsletter;
}

export async function getNewsletter(id: string): Promise<StoredNewsletter> {
  await connectDb();
  const newsletter = db.select().from(newsletters).where(eq(newsletters._id, parseId(id))).get();
  if (!newsletter) throw new OperatorError(404, "not_found", "Newsletter not found");
  return newsletter;
}

export function readNewsletterValues(body: OperatorBody, existing?: StoredNewsletter): Partial<typeof newsletters.$inferInsert> {
  assertKnownFields(body, NEWSLETTER_FIELDS);
  const values: Partial<typeof newsletters.$inferInsert> = {};
  for (const [field, max] of [["name", 200], ["fromName", 200], ["postalAddress", 1000], ["description", 200]] as const) {
    if (Object.hasOwn(body, field)) {
      values[field] = readString(body[field], field, { required: field === "name", max });
      if (field === "fromName" && /[\r\n]/.test(values[field]!)) throw new OperatorError(400, "invalid_field", "fromName must not contain line breaks");
    }
  }
  if (Object.hasOwn(body, "slug")) {
    const slug = readString(body.slug, "slug", { required: true, max: 40, trim: false });
    if (!slug || !NEWSLETTER_SLUG_PATTERN.test(slug)) throw new OperatorError(400, "invalid_slug", "slug must contain lowercase letters, numbers and hyphens, at most 40 characters and no trailing hyphen");
    values.slug = slug;
  }
  for (const field of ["fromEmail", "replyTo"] as const) {
    if (Object.hasOwn(body, field)) values[field] = field === "replyTo" && body[field] === "" ? "" : readEmail(body[field], field);
  }
  if (Object.hasOwn(body, "imageUrl")) values.imageUrl = readImage(body.imageUrl, "imageUrl");
  for (const field of ["archiveEnabled", "requireConfirmation"] as const) {
    if (Object.hasOwn(body, field)) values[field] = readBoolean(body[field], field);
  }
  if (Object.hasOwn(body, "socialLinks")) {
    if (!Array.isArray(body.socialLinks) || body.socialLinks.length > 20) throw new OperatorError(400, "invalid_social_links", "socialLinks must contain at most 20 HTTPS URLs");
    values.socialLinks = body.socialLinks.map((entry) => {
      const text = readString(entry, "socialLinks", { required: true, max: 2048 })!;
      let link: URL;
      try { link = new URL(text); } catch { throw new OperatorError(400, "invalid_social_links", "socialLinks must contain HTTPS URLs"); }
      if (link.protocol !== "https:" || link.username || link.password) throw new OperatorError(400, "invalid_social_links", "socialLinks must contain HTTPS URLs");
      return text;
    });
  }
  if (Object.hasOwn(body, "author")) {
    const author = expectObject(body.author); assertKnownFields(author, ["bio", "imageUrl"]);
    values.author = { ...existing?.author,
      ...(Object.hasOwn(author, "bio") ? { bio: readString(author.bio, "author.bio", { max: 160 })! } : {}),
      ...(Object.hasOwn(author, "imageUrl") ? { imageUrl: readImage(author.imageUrl, "author.imageUrl") } : {}),
    };
  }
  if (Object.hasOwn(body, "cleanup")) {
    const cleanup = expectObject(body.cleanup); assertKnownFields(cleanup, ["enabled", "issues", "days"]);
    values.cleanup = { enabled: false, ...existing?.cleanup,
      ...(Object.hasOwn(cleanup, "enabled") ? { enabled: readBoolean(cleanup.enabled, "cleanup.enabled") } : {}),
      ...(Object.hasOwn(cleanup, "issues") ? { issues: readInteger(cleanup.issues, "cleanup.issues", { min: CLEANUP_LIMITS.minIssues, max: CLEANUP_LIMITS.maxIssues }) } : {}),
      ...(Object.hasOwn(cleanup, "days") ? { days: readInteger(cleanup.days, "cleanup.days", { min: CLEANUP_LIMITS.minDays, max: CLEANUP_LIMITS.maxDays }) } : {}),
    };
  }
  for (const field of ["welcome", "confirmation"] as const) {
    if (!Object.hasOwn(body, field)) continue;
    const email = expectObject(body[field]);
    assertKnownFields(email, field === "welcome" ? ["enabled", "subject", "previewText", "markdown"] : ["subject", "previewText", "markdown"]);
    const content = { ...(field === "welcome" ? { enabled: false } : {}), ...existing?.[field],
      ...(Object.hasOwn(email, "subject") ? { subject: readString(email.subject, `${field}.subject`, { max: 200 })! } : {}),
      ...(Object.hasOwn(email, "previewText") ? { previewText: readString(email.previewText, `${field}.previewText`, { max: 300 })! } : {}),
      ...(Object.hasOwn(email, "markdown") ? { markdown: readString(email.markdown, `${field}.markdown`, { max: MAX_BODY_BYTES, trim: false })! } : {}),
    };
    if (content.markdown && Buffer.byteLength(content.markdown, "utf8") > MAX_BODY_BYTES) throw new OperatorError(413, "content_too_large", `${field}.markdown exceeds 500 KB`);
    if (field === "welcome") {
      const welcome = { ...content, enabled: Object.hasOwn(email, "enabled") ? readBoolean(email.enabled, "welcome.enabled") : existing?.welcome?.enabled ?? false };
      if (welcome.enabled && (!welcome.subject?.trim() || !welcome.markdown?.trim())) throw new OperatorError(400, "invalid_welcome", "An enabled welcome email needs a subject and content");
      values.welcome = welcome;
    } else values.confirmation = content;
  }
  const final = { ...existing, ...values };
  if (!final.name || !final.slug || !final.fromEmail) throw new OperatorError(400, "missing_field", "name, slug and fromEmail are required");
  if (final.requireConfirmation && (final.confirmation?.subject || final.confirmation?.markdown)) {
    const problem = getConfirmationProblem({ subject: final.confirmation?.subject ?? "", markdown: final.confirmation?.markdown ?? "" });
    if (problem) throw new OperatorError(400, "invalid_confirmation", problem);
  }
  return values;
}

export async function listNewsletters(page: OperatorPage) {
  await connectDb();
  return db.transaction((tx) => ({
    items: tx.select().from(newsletters).orderBy(desc(newsletters.createdAt), desc(newsletters._id)).limit(page.limit).offset(page.offset).all(),
    total: tx.select({ value: count() }).from(newsletters).get()?.value ?? 0, ...page,
  }));
}
export async function createNewsletter(body: OperatorBody) {
  const values = readNewsletterValues(body);
  await connectDb();
  const id = operatorId();
  db.insert(newsletters).values({ ...values, _id: id, name: values.name!, slug: values.slug!, fromEmail: values.fromEmail! }).run();
  return getNewsletter(id);
}
export async function updateNewsletter(id: string, body: OperatorBody) {
  await connectDb();
  return db.transaction((tx) => {
    const previous = tx.select().from(newsletters).where(eq(newsletters._id, parseId(id))).get();
    if (!previous) throw new OperatorError(404, "not_found", "Newsletter not found");
    const values = readNewsletterValues(body, previous);
    tx.update(newsletters).set({ ...values, updatedAt: new Date() }).where(eq(newsletters._id, id)).run();
    return tx.select().from(newsletters).where(eq(newsletters._id, id)).get()!;
  }, { behavior: "immediate" });
}
export async function deleteNewsletter(id: string, body: OperatorBody) {
  assertKnownFields(body, ["confirm"]);
  if (body.confirm !== true) throw new OperatorError(400, "confirmation_required", "Deleting a newsletter requires confirm: true");
  await connectDb();
  return db.transaction((tx) => {
    const saved = tx.select().from(newsletters).where(eq(newsletters._id, parseId(id))).get();
    if (!saved) throw new OperatorError(404, "not_found", "Newsletter not found");
    if (tx.select({ _id: contacts._id }).from(contacts).where(eq(contacts.newsletterId, id)).get() || tx.select({ _id: campaigns._id }).from(campaigns).where(eq(campaigns.newsletterId, id)).get() || tx.select({ _id: messages._id }).from(messages).where(eq(messages.newsletterId, id)).get()) {
      throw new OperatorError(409, "has_dependents", "Newsletter has contacts, campaigns or messages; deletion is blocked");
    }
    tx.delete(newsletters).where(eq(newsletters._id, id)).run();
    if (tx.select({ _id: newsletters._id }).from(newsletters).where(eq(newsletters._id, id)).get()) throw new OperatorError(500, "write_failed", "Newsletter was not removed");
    return { ...saved, removed: true };
  }, { behavior: "immediate" });
}

export function contactWhere(params: URLSearchParams): SQL | undefined {
  const filters: SQL[] = [];
  for (const field of ["newsletter", "status", "email", "q"]) if (params.getAll(field).length > 1) throw new OperatorError(400, "invalid_filter", `${field} may be specified only once`);
  if (params.has("newsletter")) filters.push(eq(contacts.newsletterId, newsletterBySlug(params.get("newsletter"))._id));
  if (params.has("status")) {
    const status = params.get("status");
    if (!CONTACT_STATUSES.includes(status as typeof CONTACT_STATUSES[number])) throw new OperatorError(400, "invalid_status", "Unknown contact status");
    filters.push(eq(contacts.status, status as typeof CONTACT_STATUSES[number]));
  }
  if (params.has("email")) filters.push(eq(contacts.email, readEmail(params.get("email"))));
  if (params.has("q")) {
    const search = readString(params.get("q"), "q", { max: 254 })!;
    const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    filters.push(sql`${contacts.email} like ${pattern} escape '\\'`);
  }
  return and(...filters);
}
export async function listContacts(page: OperatorPage, params: URLSearchParams) {
  await connectDb();
  const where = contactWhere(params);
  return db.transaction((tx) => ({
    items: tx.select().from(contacts).where(where).orderBy(desc(contacts.subscribedAt), desc(contacts._id)).limit(page.limit).offset(page.offset).all(),
    total: tx.select({ value: count() }).from(contacts).where(where).get()?.value ?? 0, ...page,
  }));
}
export async function getContact(id: string): Promise<StoredContact> {
  await connectDb();
  const saved = db.select().from(contacts).where(eq(contacts._id, parseId(id))).get();
  if (!saved) throw new OperatorError(404, "not_found", "Contact not found");
  return saved;
}
export async function createContact(body: OperatorBody) {
  assertKnownFields(body, ["newsletter", "email", "source", "resubscribe", "ip"]);
  const email = readEmail(body.email);
  const source = readString(body.source, "source", { max: 100 }) || "api";
  const resubscribe = body.resubscribe === undefined ? false : readBoolean(body.resubscribe, "resubscribe");
  // Keep the legacy optional ip payload compatible. It is not trusted request identity.
  await connectDb();
  const newsletter = newsletterBySlug(body.newsletter);
  const result = await upsertContact({ newsletter, email, source, resubscribe });
  const saved = await getContact(result.contact._id);
  return { ...saved, id: saved._id, created: result.created,
    ...(saved.status === "pending" ? { inbox: getInbox({ email, fromEmail: newsletter.fromEmail }) } : {}),
  };
}
export async function updateContact(id: string, body: OperatorBody) {
  assertKnownFields(body, ["source"]);
  const source = readString(body.source, "source", { required: true, max: 100 })!;
  await connectDb();
  return db.transaction((tx) => {
    const previous = tx.select().from(contacts).where(eq(contacts._id, parseId(id))).get();
    if (!previous) throw new OperatorError(404, "not_found", "Contact not found");
    // Freeze the legacy import heuristic before the editable source label can change it.
    const imported = previous.source === "import" && previous.imported?.subscribedAtKnown === undefined &&
      Math.abs(previous.subscribedAt.getTime() - previous.createdAt.getTime()) < 60_000
      ? { ...previous.imported, subscribedAtKnown: false }
      : previous.imported;
    tx.update(contacts).set({ source, imported, updatedAt: new Date() }).where(eq(contacts._id, id)).run();
    return tx.select().from(contacts).where(eq(contacts._id, id)).get()!;
  }, { behavior: "immediate" });
}
export async function setContactStatus(id: string, body: OperatorBody) {
  assertKnownFields(body, ["status"]);
  if (body.status !== "active" && body.status !== "unsubscribed") throw new OperatorError(400, "invalid_status", "status must be active or unsubscribed");
  const status = body.status;
  await connectDb();
  return db.transaction((tx) => {
    const previous = tx.select().from(contacts).where(eq(contacts._id, parseId(id))).get();
    if (!previous) throw new OperatorError(404, "not_found", "Contact not found");
    if (status === "active" && tx.select({ _id: suppressions._id }).from(suppressions).where(eq(suppressions.email, previous.email)).get()) throw new OperatorError(409, "suppressed", "A suppressed contact cannot be reactivated");
    const now = new Date();
    const eligible = status === "active" ? ["dormant"] as const : ["active", "pending", "dormant"] as const;
    const changed = tx.update(contacts).set(status === "active"
      ? { status, ignoredIssues: 0, lastEngagedAt: sql`max(coalesce(${contacts.lastEngagedAt}, 0), ${now.getTime()})`, updatedAt: now }
      : { status, unsubscribedAt: now, confirmationNonce: null, updatedAt: now }).where(and(eq(contacts._id, id), inArray(contacts.status, [...eligible]))).run();
    if (!changed.changes) throw new OperatorError(409, "invalid_transition", "Contact status cannot change");
    return tx.select().from(contacts).where(eq(contacts._id, id)).get()!;
  }, { behavior: "immediate" });
}
export async function deleteContact(id: string, body: OperatorBody) {
  assertKnownFields(body, ["confirm"]);
  if (body.confirm !== true) throw new OperatorError(400, "confirmation_required", "Deleting a contact requires confirm: true");
  await connectDb();
  return db.transaction((tx) => {
    const saved = tx.select().from(contacts).where(eq(contacts._id, parseId(id))).get();
    if (!saved) throw new OperatorError(404, "not_found", "Contact not found");
    if (!["active", "pending", "dormant"].includes(saved.status)) throw new OperatorError(409, "protected_opt_out", "Opt-outs, bounces and complaints cannot be erased; retain the consent history");
    if (tx.select({ _id: messages._id }).from(messages).where(eq(messages.contactId, id)).get()) throw new OperatorError(409, "has_history", "Contact has message history; unsubscribe instead of deleting");
    tx.delete(contacts).where(eq(contacts._id, id)).run();
    if (tx.select({ _id: contacts._id }).from(contacts).where(eq(contacts._id, id)).get()) throw new OperatorError(500, "write_failed", "Contact was not removed");
    return { ...saved, removed: true };
  }, { behavior: "immediate" });
}
export async function importContacts(body: OperatorBody) {
  assertKnownFields(body, ["newsletter", "rows", "source"]);
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 1000) throw new OperatorError(400, "invalid_rows", "rows must contain between 1 and 1000 entries");
  const source = readString(body.source, "source", { max: 100 }) || "import";
  const rows = body.rows.map((entry, index) => {
    const row = expectObject(entry); assertKnownFields(row, ["email", "status", "subscribedAt", "emailsReceived", "openRate", "clickRate"]);
    const email = readEmail(row.email, `rows[${index}].email`);
    const status = row.status ?? "active";
    if (!["active", "dormant", "unsubscribed", "bounced", "complained"].includes(String(status))) throw new OperatorError(400, "invalid_status", `rows[${index}].status is invalid`);
    const subscribedAt = row.subscribedAt === undefined ? undefined : readDate(row.subscribedAt, "subscribedAt").toISOString();
    const emailsReceived = row.emailsReceived === undefined ? undefined : readInteger(row.emailsReceived, "emailsReceived", { min: 0 });
    for (const field of ["openRate", "clickRate"]) if (row[field] !== undefined && (typeof row[field] !== "number" || !Number.isFinite(row[field]) || row[field] < 0 || row[field] > 1)) throw new OperatorError(400, "invalid_rate", `${field} must be a number between 0 and 1`);
    return { email, status, subscribedAt, emailsReceived, openRate: row.openRate, clickRate: row.clickRate };
  });
  await connectDb();
  const newsletter = newsletterBySlug(body.newsletter);
  const result = await importContactRows({ newsletterId: newsletter._id, rows, source });
  // Return persisted rows so callers can verify the import's actual consent outcomes.
  const emails = [...new Set(rows.map((row) => row.email))];
  const items = db.select().from(contacts).where(and(eq(contacts.newsletterId, newsletter._id), inArray(contacts.email, emails))).all();
  return { ...result, items, total: items.length };
}
