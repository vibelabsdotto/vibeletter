import "server-only";
import { and, count, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { connectDb, db } from "@/db";
import { campaigns, events, messages, newsletters } from "@/db/schema";
import { getProviderBreakdown } from "@/lib/campaign-reports";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { firstImageUrl } from "@/lib/thumbnail";
import { uniqueArchiveSlug } from "@/lib/archive-slugs";
import { renderEmail } from "@/lib/render-email";
import { getSendProblem } from "@/lib/sending-rules";
import { getScheduleProblem } from "@/lib/schedule";
import { publishScheduledSend } from "@/lib/scheduling";
import { queueCampaign, sendTestEmail, sendToMoreContacts, getCleanupPreview } from "@/lib/sending";
import { MAX_BODY_BYTES } from "@/lib/validation";
import { newsletterBySlug, operatorId, readEmail } from "@/lib/operator-services";
import { assertKnownFields, OperatorError, parseId, readBoolean, readDate, readInteger, readString, type OperatorBody, type OperatorPage } from "@/lib/operator-api";

export type StoredCampaign = typeof campaigns.$inferSelect;
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "paused", "sent", "canceled"] as const;
const EDITABLE_STATUSES = ["draft", "scheduled"] as const;
const PUBLISHED_STATUSES = ["sending", "paused", "sent"] as const;
const CAMPAIGN_FIELDS = ["subject", "previewText", "html", "markdown", "format", "archiveSlug", "audienceLimit", "archiveListed"];

function archiveSlug(value: unknown): string | null {
  if (value === null || value === "") return null;
  const slug = readString(value, "archiveSlug", { required: true, max: 120, trim: false });
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) throw new OperatorError(400, "invalid_slug", "archiveSlug may only contain lowercase letters, numbers and hyphens");
  return slug;
}
function audienceLimit(value: unknown): number | null {
  return value === null ? null : readInteger(value, "audienceLimit");
}
function readCampaignValues(body: OperatorBody, previous?: StoredCampaign): Partial<typeof campaigns.$inferInsert> {
  assertKnownFields(body, previous ? CAMPAIGN_FIELDS : ["newsletter", ...CAMPAIGN_FIELDS]);
  const values: Partial<typeof campaigns.$inferInsert> = {};
  for (const [field, max] of [["subject", 200], ["previewText", 300], ["html", MAX_BODY_BYTES], ["markdown", MAX_BODY_BYTES]] as const) {
    if (Object.hasOwn(body, field)) {
      // The retained creation API treats null optional content/preview fields as empty.
      values[field] = body[field] === null && field !== "subject"
        ? ""
        : readString(body[field], field, { max, trim: field !== "html" && field !== "markdown" })!;
      if ((field === "subject" || field === "previewText") && /[\r\n]/.test(values[field]!)) throw new OperatorError(400, "invalid_field", `${field} must not contain line breaks`);
      if ((field === "html" || field === "markdown") && Buffer.byteLength(values[field]!, "utf8") > MAX_BODY_BYTES) throw new OperatorError(413, "content_too_large", `${field} must be at most 500 KB`);
    }
  }
  if (Object.hasOwn(body, "format")) {
    if (body.format !== "markdown" && body.format !== "html" && body.format !== "rich") throw new OperatorError(400, "invalid_format", "format must be markdown, html or rich");
    values.format = body.format;
  }
  const html = typeof body.html === "string" && Boolean(body.html.trim());
  const markdown = typeof body.markdown === "string" && Boolean(body.markdown.trim());
  if (html && markdown) throw new OperatorError(400, "ambiguous_content", "Send either html or markdown, not both");
  if (!Object.hasOwn(body, "format")) {
    if (markdown) values.format = "markdown";
    else if (html) values.format = previous?.format === "rich" ? "rich" : "html";
  }
  const format = values.format ?? previous?.format ?? "rich";
  if ((format === "markdown" && html) || (format !== "markdown" && markdown)) throw new OperatorError(400, "invalid_content", "Content does not match format");
  if (values.format && values.format !== previous?.format) {
    if (values.format === "markdown") values.html = "";
    else values.markdown = "";
  }
  if (Object.hasOwn(body, "archiveSlug")) values.archiveSlug = archiveSlug(body.archiveSlug);
  if (Object.hasOwn(body, "audienceLimit")) values.audienceLimit = audienceLimit(body.audienceLimit);
  if (Object.hasOwn(body, "archiveListed")) values.archiveListed = readBoolean(body.archiveListed, "archiveListed");
  if (Object.hasOwn(body, "html") || Object.hasOwn(body, "markdown") || Object.hasOwn(body, "format")) {
    values.thumbnailUrl = firstImageUrl({ format, html: values.html ?? previous?.html ?? "", markdown: values.markdown ?? previous?.markdown ?? "" }) ?? null;
  }
  return values;
}

export async function getCampaign(id: string): Promise<StoredCampaign> {
  await connectDb();
  const saved = db.select().from(campaigns).where(eq(campaigns._id, parseId(id))).get();
  if (!saved) throw new OperatorError(404, "not_found", "Campaign not found");
  return saved;
}
export async function listCampaigns(page: OperatorPage, params: URLSearchParams) {
  await connectDb();
  const filters: SQL[] = [];
  for (const field of ["newsletter", "status"]) if (params.getAll(field).length > 1) throw new OperatorError(400, "invalid_filter", `${field} may be specified only once`);
  const newsletter = params.has("newsletter") ? newsletterBySlug(params.get("newsletter")) : null;
  if (newsletter) filters.push(eq(campaigns.newsletterId, newsletter._id));
  if (params.has("status")) {
    const status = params.get("status");
    if (!CAMPAIGN_STATUSES.includes(status as typeof CAMPAIGN_STATUSES[number])) throw new OperatorError(400, "invalid_status", "Unknown campaign status");
    filters.push(eq(campaigns.status, status as typeof CAMPAIGN_STATUSES[number]));
  }
  const where = and(...filters);
  return db.transaction((tx) => {
    const items = tx.select().from(campaigns).where(where).orderBy(desc(campaigns.createdAt), desc(campaigns._id)).limit(page.limit).offset(page.offset).all();
    const total = tx.select({ value: count() }).from(campaigns).where(where).get()?.value ?? 0;
    // Keep legacy published issues separate from the operator's draft-inclusive list.
    const issuesWhere = and(newsletter ? eq(campaigns.newsletterId, newsletter._id) : undefined, inArray(campaigns.status, [...PUBLISHED_STATUSES]), eq(campaigns.archiveListed, true), isNotNull(campaigns.archiveSlug));
    const published = tx.select().from(campaigns).where(issuesWhere).orderBy(desc(campaigns.sentAt), desc(campaigns.startedAt), desc(campaigns._id)).limit(page.limit).offset(page.offset).all();
    const issuesTotal = tx.select({ value: count() }).from(campaigns).where(issuesWhere).get()?.value ?? 0;
    const urls = newsletter?.archiveEnabled ? getArchiveUrls(newsletter) : null;
    const issues = published.map((item) => ({ id: item._id, subject: item.subject, previewText: item.previewText, archiveSlug: item.archiveSlug,
      url: urls && item.archiveSlug ? urls.absolutePost(item.archiveSlug) : null, sentAt: item.sentAt ?? item.startedAt ?? null }));
    return { items, total, ...page, issues, issuesTotal, issuesLimit: page.limit, issuesOffset: page.offset };
  });
}
export async function createCampaign(body: OperatorBody) {
  const values = readCampaignValues(body);
  await connectDb();
  const newsletter = newsletterBySlug(body.newsletter);
  const id = operatorId();
  // Preserve legacy API creation: a requested archive slug is made unique, then read back.
  if (values.archiveSlug) values.archiveSlug = await uniqueArchiveSlug(values.archiveSlug);
  db.insert(campaigns).values({ ...values, _id: id, newsletterId: newsletter._id, source: "api" }).run();
  const saved = await getCampaign(id);
  return { ...saved, id, url: `${getAppUrl()}/campaigns/${id}` };
}
export async function updateCampaign(id: string, body: OperatorBody) {
  const previous = await getCampaign(id);
  if (!EDITABLE_STATUSES.includes(previous.status as typeof EDITABLE_STATUSES[number])) throw new OperatorError(409, "not_editable", "Only drafts and scheduled campaigns may be edited");
  const values = readCampaignValues(body, previous);
  const changed = db.update(campaigns).set({ ...values, updatedAt: new Date() }).where(and(eq(campaigns._id, id), inArray(campaigns.status, [...EDITABLE_STATUSES]), eq(campaigns.updatedAt, previous.updatedAt))).run();
  if (!changed.changes) throw new OperatorError(409, "campaign_changed", "Campaign changed; reload and retry");
  return getCampaign(id);
}
async function transition(id: string, allowed: readonly StoredCampaign["status"][], values: Partial<typeof campaigns.$inferInsert>) {
  const changed = db.update(campaigns).set({ ...values, updatedAt: new Date() }).where(and(eq(campaigns._id, id), inArray(campaigns.status, [...allowed]))).run();
  if (!changed.changes) throw new OperatorError(409, "invalid_transition", "Action is not permitted in the campaign's current state");
  return getCampaign(id);
}
export async function deleteCampaign(id: string, body: OperatorBody) {
  assertKnownFields(body, ["confirm"]);
  if (body.confirm !== true) throw new OperatorError(400, "confirmation_required", "Discarding a campaign requires confirm: true");
  await getCampaign(id);
  return transition(id, EDITABLE_STATUSES, { status: "canceled", scheduledAt: null });
}
export async function previewCampaign(id: string) {
  const campaign = await getCampaign(id);
  const newsletter = db.select().from(newsletters).where(eq(newsletters._id, campaign.newsletterId)).get();
  if (!newsletter) throw new OperatorError(404, "not_found", "Newsletter not found");
  const webUrl = newsletter.archiveEnabled && campaign.archiveSlug ? getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug) : null;
  const input = { ...campaign, newsletter, webUrl };
  return { campaign, newsletter, ...renderEmail(input as Parameters<typeof renderEmail>[0]) };
}
export async function reportCampaign(id: string, page: OperatorPage) {
  await getCampaign(id);
  const where = eq(messages.campaignId, id);
  return db.transaction((tx) => {
    const campaign = tx.select().from(campaigns).where(eq(campaigns._id, id)).get();
    if (!campaign) throw new OperatorError(404, "not_found", "Campaign not found");
    const eventWhere = eq(events.campaignId, id);
    return {
      campaign, stats: campaign.stats, lastChance: campaign.lastChance,
      providers: getProviderBreakdown(id, tx),
      messages: { items: tx.select().from(messages).where(where).orderBy(desc(messages.createdAt), desc(messages._id)).limit(page.limit).offset(page.offset).all(),
        total: tx.select({ value: count() }).from(messages).where(where).get()?.value ?? 0, ...page },
      events: { items: tx.select().from(events).where(eventWhere).orderBy(desc(events.occurredAt), desc(events._id)).limit(page.limit).offset(page.offset).all(),
        total: tx.select({ value: count() }).from(events).where(eventWhere).get()?.value ?? 0, ...page },
      statuses: tx.select({ status: messages.status, total: count() }).from(messages).where(where).groupBy(messages.status).all(),
    };
  });
}
function requireSending(): void {
  if (!isSendingEnabled()) throw new OperatorError(503, "sending_disabled", "Sending is disabled. Enable SENDING_ENABLED explicitly before sending");
}
export async function campaignAction(id: string, body: OperatorBody) {
  const action = readString(body.action, "action", { required: true, max: 40 })!;
  const fields: Record<string, string[]> = {
    send: ["audienceLimit"], test: ["to"], schedule: ["scheduledAt", "audienceLimit"], unschedule: [],
    pause: [], resume: [], "send-more": ["additional"], duplicate: [], "archive-slug": ["archiveSlug"],
    pin: ["pinned"], discard: [], "cleanup-preview": [],
  };
  if (!Object.hasOwn(fields, action)) throw new OperatorError(400, "invalid_action", "Unknown campaign action");
  assertKnownFields(body, ["action", ...fields[action]]);
  const previous = await getCampaign(id);
  if (action === "cleanup-preview") return getCleanupPreview(id);
  if (action === "duplicate") {
    const copyId = operatorId();
    db.insert(campaigns).values({ _id: copyId, newsletterId: previous.newsletterId, subject: previous.subject ? `${previous.subject.slice(0, 193)} (copy)` : "", previewText: previous.previewText, format: previous.format,
      markdown: previous.markdown, html: previous.html, thumbnailUrl: previous.thumbnailUrl, source: previous.source }).run();
    return getCampaign(copyId);
  }
  if (action === "discard") return transition(id, EDITABLE_STATUSES, { status: "canceled", scheduledAt: null });
  if (action === "unschedule") return transition(id, ["scheduled"], { status: "draft", scheduledAt: null });
  if (action === "pause") return transition(id, ["sending"], { status: "paused" });
  if (action === "archive-slug") {
    const slug = archiveSlug(body.archiveSlug);
    if (!slug && PUBLISHED_STATUSES.includes(previous.status as typeof PUBLISHED_STATUSES[number])) throw new OperatorError(409, "published_slug_required", "A published campaign must retain an archive slug");
    const changed = db.update(campaigns).set({ archiveSlug: slug, updatedAt: new Date() }).where(and(eq(campaigns._id, id), ne(campaigns.status, "canceled"), eq(campaigns.status, previous.status))).run();
    if (!changed.changes) throw new OperatorError(409, "campaign_changed", "Campaign changed; reload and retry");
    return getCampaign(id);
  }
  if (action === "pin") {
    if (!previous.archiveSlug || !previous.archiveListed || previous.status === "canceled") throw new OperatorError(409, "not_listed", "Campaign is not listed in the archive");
    const pinned = body.pinned === undefined ? sql<boolean>`not ${campaigns.archivePinned}` : readBoolean(body.pinned, "pinned");
    const changed = db.update(campaigns).set({ archivePinned: pinned, updatedAt: new Date() }).where(and(eq(campaigns._id, id), eq(campaigns.archiveListed, true), ne(campaigns.status, "canceled"), eq(campaigns.archiveSlug, previous.archiveSlug))).run();
    if (!changed.changes) throw new OperatorError(409, "campaign_changed", "Campaign changed; reload and retry");
    return getCampaign(id);
  }
  requireSending();
  if (action === "test") {
    const to = readEmail(body.to ?? process.env.ADMIN_EMAIL, "to");
    const result = await sendTestEmail({ campaignId: id, to });
    return { campaign: await getCampaign(id), result: result ?? null };
  }
  if (action === "resume") {
    if (previous.status !== "paused") throw new OperatorError(409, "invalid_transition", "Only paused campaigns may be resumed");
    const result = await queueCampaign(id);
    return { campaign: await getCampaign(id), result: result ?? null };
  }
  if (action === "send-more") {
    if (previous.status !== "sent") throw new OperatorError(409, "invalid_transition", "Only sent campaigns may send to additional contacts");
    const additional = body.additional === undefined ? undefined : readInteger(body.additional, "additional");
    const result = await sendToMoreContacts(id, additional);
    return { campaign: await getCampaign(id), result: result ?? null };
  }
  if (!EDITABLE_STATUSES.includes(previous.status as typeof EDITABLE_STATUSES[number])) throw new OperatorError(409, "invalid_transition", "Only drafts and scheduled campaigns may be sent or scheduled");
  const limit = body.audienceLimit === undefined ? previous.audienceLimit : audienceLimit(body.audienceLimit);
  const newsletter = db.select().from(newsletters).where(eq(newsletters._id, previous.newsletterId)).get();
  if (!newsletter) throw new OperatorError(404, "not_found", "Newsletter not found");
  const sendProblem = getSendProblem({ campaign: previous, newsletter });
  if (sendProblem) throw new OperatorError(422, "send_validation_failed", sendProblem);
  if (action === "send") {
    const updatedAt = new Date(Math.max(Date.now(), previous.updatedAt.getTime() + 1));
    const changed = db.update(campaigns).set({ audienceLimit: limit, updatedAt }).where(and(eq(campaigns._id, id), inArray(campaigns.status, [...EDITABLE_STATUSES]), eq(campaigns.updatedAt, previous.updatedAt))).run();
    if (!changed.changes) throw new OperatorError(409, "campaign_changed", "Campaign changed; reload and retry");
    try {
      const result = await queueCampaign(id);
      return { campaign: await getCampaign(id), result: result ?? null };
    } catch (error) {
      // Preserve an existing schedule on failure, but never undo a worker/concurrent edit.
      db.update(campaigns).set({ audienceLimit: previous.audienceLimit, updatedAt: new Date(Math.max(Date.now(), updatedAt.getTime() + 1)) })
        .where(and(eq(campaigns._id, id), eq(campaigns.status, previous.status), eq(campaigns.updatedAt, updatedAt),
          previous.scheduledAt ? eq(campaigns.scheduledAt, previous.scheduledAt) : isNull(campaigns.scheduledAt),
          limit === null ? isNull(campaigns.audienceLimit) : eq(campaigns.audienceLimit, limit))).run();
      throw error;
    }
  }
  const at = readDate(body.scheduledAt, "scheduledAt");
  const problem = getScheduleProblem(at);
  if (problem) throw new OperatorError(400, "invalid_schedule", problem);
  const updatedAt = new Date(Math.max(Date.now(), previous.updatedAt.getTime() + 1));
  const changed = db.update(campaigns).set({ status: "scheduled", scheduledAt: at, audienceLimit: limit, updatedAt }).where(and(eq(campaigns._id, id), inArray(campaigns.status, [...EDITABLE_STATUSES]), eq(campaigns.updatedAt, previous.updatedAt))).run();
  if (!changed.changes) throw new OperatorError(409, "campaign_changed", "Campaign changed; reload and retry");
  try {
    const result = await publishScheduledSend({ campaignId: id, scheduledAt: at });
    return { campaign: await getCampaign(id), result: result ?? null };
  } catch (error) {
    // Roll back only our exact reservation; never overwrite a concurrent edit or worker transition.
    db.update(campaigns).set({ status: previous.status, scheduledAt: previous.scheduledAt, audienceLimit: previous.audienceLimit, updatedAt: new Date(Math.max(Date.now(), updatedAt.getTime() + 1)) }).where(and(eq(campaigns._id, id), eq(campaigns.status, "scheduled"), eq(campaigns.scheduledAt, at), eq(campaigns.updatedAt, updatedAt), limit === null ? isNull(campaigns.audienceLimit) : eq(campaigns.audienceLimit, limit))).run();
    throw error;
  }
}
