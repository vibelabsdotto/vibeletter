import "server-only";
import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, notExists, or, sql, type SQLWrapper } from "drizzle-orm";
import { RetryAfterError } from "liteque";
import { connectDb, db } from "@/db";
import { campaigns, contacts, messages, newsletters, suppressions } from "@/db/schema";
import { sendAlert } from "@/lib/alerts";
import { assignArchiveSlug } from "@/lib/archive-slugs";
import { addToPreview, emptyPreview, getCleanupSettings, splitAudience } from "@/lib/cleanup";
import { LIMITS, isSendingEnabled } from "@/lib/config";
import { getConfirmUrl } from "@/lib/confirmation";
import { getConfirmationContent } from "@/lib/confirmation-content";
import { getKeepUrl } from "@/lib/last-chance";
import { getLastChanceContent } from "@/lib/last-chance-content";
import { mailboxProvider } from "@/lib/providers";
import { reserveSendSlot } from "@/lib/rate-limit";
import { listSesDomains, sendSesEmail } from "@/lib/ses";
import {
	MAX_BATCH_MESSAGES,
	MAX_CONSECUTIVE_FAILURES,
	TEST_CONTACT_ID,
	buildRecipientEmail,
	chunk,
	getCampaignPauseReason,
	getFeedbackId,
	getNextStepLimit,
	getSendErrorAction,
	getSendProblem,
	getWelcomeContent,
} from "@/lib/sending-rules";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import { enqueueMessage, enqueueMessages } from "@/queue";

export { buildRecipientEmail } from "@/lib/sending-rules";

type Campaign = typeof campaigns.$inferSelect;
type Contact = typeof contacts.$inferSelect;
type Message = typeof messages.$inferSelect;
type Newsletter = typeof newsletters.$inferSelect;
type Store = Pick<typeof db, "select" | "insert" | "update">;
type SignupKind = "welcome" | "confirmation";
type SignupInput = { newsletter: Pick<Newsletter, "_id">; contact: Pick<Contact, "_id"> | null | undefined };
type EmailContent = {
	format: string;
	subject: string;
	previewText?: string | null;
	markdown?: string | null;
	html?: string | null;
	replyTo?: string | null;
	_id?: string;
	archiveSlug?: string | null;
	archiveListed?: boolean;
};
export type SendResult = { sent: number; failed: number; suppressed: number; skipped: number; unknown: number; retry: boolean };

const CAMPAIGN_KINDS = ["campaign", "last-chance"] as const;
const SIGNUP_KINDS = ["welcome", "confirmation"] as const;
const QUEUEABLE_STATUSES = new Set<Campaign["status"]>(["draft", "scheduled", "paused"]);
const INSERT_CHUNK_SIZE = 1000;
const PUBLISH_CHUNK_SIZE = 100;
const WELCOME_WINDOW_MS = 10 * 60 * 1000;
const MAX_CONFIRMATIONS_PER_CONTACT = 3;
const UNTRACKED_KINDS = new Set<Message["kind"]>(["confirmation", "last-chance"]);
const DEFINITE_REJECTIONS = new Set([
	"TooManyRequestsException", "ThrottlingException", "Throttling", "AccountSuspendedException",
	"SendingPausedException", "MailFromDomainNotVerifiedException", "LimitExceededException",
	"NotFoundException", "MessageRejected", "BadRequestException", "AccessDeniedException", "ValidationException",
]);

function assertSendingEnabled() {
	if (!isSendingEnabled()) throw new Error("Sending is off");
}

function formatError(error: unknown): string {
	return String(error instanceof Error ? error.message : error).slice(0, 500);
}

// liteque 0.10 takes a millisecond delay, not a Date. Keep the retry deadline explicit here.
function retryAt(date: Date): RetryAfterError {
	return new RetryAfterError(Math.max(1, date.getTime() - Date.now()));
}

function newId(): string {
	return randomBytes(12).toString("hex");
}

function emptySendResult(): SendResult {
	return { sent: 0, failed: 0, suppressed: 0, skipped: 0, unknown: 0, retry: false };
}

function isCampaignMessage(kind: Message["kind"]): boolean {
	return kind === "campaign" || kind === "last-chance";
}

function jsonCounter(column: SQLWrapper, key: string, amount = 1) {
	const path = `$.${key}`;
	return sql`json_set(coalesce(${column}, '{}'), ${path}, coalesce(json_extract(${column}, ${path}), 0) + ${amount})`;
}

function setJsonCounter(column: SQLWrapper, key: string, value: number) {
	return sql`json_set(coalesce(${column}, '{}'), ${`$.${key}`}, ${value})`;
}

function incrementCampaignCounter(store: Store, campaignId: string, kind: Message["kind"], key: string, amount = 1) {
	const counters = kind === "last-chance"
		? { lastChance: jsonCounter(campaigns.lastChance, key, amount) }
		: { stats: jsonCounter(campaigns.stats, key, amount) };
	store.update(campaigns).set({ ...counters, updatedAt: new Date() }).where(eq(campaigns._id, campaignId)).run();
}

async function pauseCampaign(campaignId: string, reason: string) {
	const changed = db.update(campaigns).set({ status: "paused", updatedAt: new Date() })
		.where(and(eq(campaigns._id, campaignId), eq(campaigns.status, "sending")))
		.returning({ _id: campaigns._id }).get();
	if (!changed) return;
	await sendAlert({ key: `campaign-paused-${campaignId}`, title: "Campaign paused", detail: reason,
		path: `/campaigns/${campaignId}`, cooldownMinutes: 1 });
}

async function pauseIfUnhealthy(campaignId: string): Promise<boolean> {
	const campaign = db.select().from(campaigns)
		.where(and(eq(campaigns._id, campaignId), eq(campaigns.status, "sending"))).get();
	const reason = campaign ? getCampaignPauseReason(campaign.stats, campaign.lastChance) : null;
	if (reason) await pauseCampaign(campaignId, `${reason} is over the limit`);
	return Boolean(reason);
}

export async function settleCampaign(campaignId: string) {
	if (await pauseIfUnhealthy(campaignId)) return;
	// In-flight and uncertain sends are not finished. A lease retry must never turn them into a resend.
	db.transaction((tx) => {
		const pending = tx.select({ _id: messages._id }).from(messages).where(and(
			eq(messages.campaignId, campaignId), inArray(messages.kind, [...CAMPAIGN_KINDS]),
			inArray(messages.status, ["queued", "sending", "unknown"]),
		)).limit(1).get();
		if (pending) return;
		tx.update(campaigns).set({ status: "sent", sentAt: sql`coalesce(${campaigns.sentAt}, ${Date.now()})`, updatedAt: new Date() })
			.where(and(eq(campaigns._id, campaignId), eq(campaigns.status, "sending"))).run();
	}, { behavior: "immediate" });
}

function normalizedLimit(value: unknown): number | null {
	const limit = Number(value);
	return Number.isInteger(limit) && limit > 0 ? limit : null;
}

function findPreviousMessages(store: Store, campaignId: string): Map<string, Message["kind"]> {
	const previous = store.select({ contactId: messages.contactId, kind: messages.kind }).from(messages)
		.where(and(eq(messages.campaignId, campaignId), inArray(messages.kind, [...CAMPAIGN_KINDS]))).all();
	return new Map(previous.flatMap(({ contactId, kind }) => contactId ? [[contactId, kind] as const] : []));
}

function findAudience(store: Store, campaign: Pick<Campaign, "_id" | "newsletterId">, cleanupEnabled: boolean, audienceLimit?: number | null) {
	const limit = normalizedLimit(audienceLimit);
	const unsuppressed = notExists(store.select({ _id: suppressions._id }).from(suppressions)
		.where(eq(suppressions.email, contacts.email)));
	const query = store.select().from(contacts).where(and(
		eq(contacts.newsletterId, campaign.newsletterId), eq(contacts.status, "active"), unsuppressed,
	)).orderBy(desc(contacts.lastClickAt), desc(contacts.lastOpenAt),
		sql`json_extract(${contacts.imported}, '$.clickRate') desc`,
		sql`json_extract(${contacts.imported}, '$.openRate') desc`, asc(contacts.createdAt), asc(contacts._id)).$dynamic();
	if (limit && !cleanupEnabled) query.limit(limit);
	// Snapshot the ordered audience before changing contact statuses. Offset pagination would skip rows
	// when cleanup makes contacts dormant; an open SQLite cursor can also see its own writes.
	return { audience: query.all(), limit, previous: cleanupEnabled ? findPreviousMessages(store, campaign._id) : new Map<string, Message["kind"]>() };
}

function toMessages(campaign: Campaign, kind: "campaign" | "last-chance", recipients: Contact[]): (typeof messages.$inferInsert)[] {
	const now = new Date();
	return recipients.map((contact) => ({ _id: newId(), kind, campaignId: campaign._id,
		newsletterId: campaign.newsletterId, contactId: contact._id, email: contact.email,
		provider: mailboxProvider(contact.email), status: "queued", createdAt: now, updatedAt: now }));
}

function insertIgnoringDuplicates(store: Store, rows: (typeof messages.$inferInsert)[]) {
	if (rows.length > 0) store.insert(messages).values(rows).onConflictDoNothing().run();
}

function makeDormant(store: Store, campaignId: string, dormant: Contact[]) {
	if (dormant.length === 0) return 0;
	const changed = store.update(contacts).set({ status: "dormant", updatedAt: new Date() }).where(and(
		inArray(contacts._id, dormant.map(({ _id }) => _id)), eq(contacts.status, "active"), gt(contacts.ignoredIssues, 0),
	)).returning({ _id: contacts._id }).all();
	if (changed.length) incrementCampaignCounter(store, campaignId, "last-chance", "dormant", changed.length);
	return changed.length;
}

function insertCampaignMessages(store: Store, campaign: Campaign, newsletter: Newsletter) {
	const settings = getCleanupSettings(newsletter);
	const { audience, limit, previous } = findAudience(store, campaign, settings.enabled, campaign.audienceLimit);
	let remaining = limit ?? Infinity;
	let dormant = 0;
	const now = Date.now();
	for (const group of chunk(audience, INSERT_CHUNK_SIZE) as Contact[][]) {
		const split = splitAudience(group, { settings, limit: remaining, previous, now }) as {
			issue: Contact[]; lastChance: Contact[]; dormant: Contact[]; received: number;
		};
		insertIgnoringDuplicates(store, toMessages(campaign, "campaign", split.issue));
		insertIgnoringDuplicates(store, toMessages(campaign, "last-chance", split.lastChance));
		dormant += makeDormant(store, campaign._id, split.dormant);
		remaining -= split.issue.length + split.received;
		if (remaining <= 0) break;
	}
	return dormant;
}

export async function getCleanupPreview(campaignId: string) {
	if (!isObjectIdString(campaignId)) throw new Error("Campaign not found");
	await connectDb();
	return db.transaction((tx) => {
		const campaign = tx.select().from(campaigns).where(eq(campaigns._id, campaignId)).get();
		if (!campaign) throw new Error("Campaign not found");
		const newsletter = tx.select().from(newsletters).where(eq(newsletters._id, campaign.newsletterId)).get();
		const settings = getCleanupSettings(newsletter);
		if (!settings.enabled) return { enabled: false as const };
		const { audience, previous } = findAudience(tx, campaign, true);
		const preview = emptyPreview() as { issue: number; lastChance: number[]; waiting: number[]; dormant: number[] };
		const now = Date.now();
		for (const group of chunk(audience, INSERT_CHUNK_SIZE) as Contact[][]) addToPreview(preview, group, { settings, previous, now });
		return { enabled: true as const, ...preview };
	});
}

function countCampaignMessages(store: Store, campaignId: string): [number, number] {
	return CAMPAIGN_KINDS.map((kind) => store.select({ total: count() }).from(messages)
		.where(and(eq(messages.campaignId, campaignId), eq(messages.kind, kind))).get()?.total ?? 0) as [number, number];
}

async function publishQueuedMessages(campaignId: string): Promise<number> {
	const queued = db.select({ _id: messages._id }).from(messages).where(and(
		eq(messages.campaignId, campaignId), inArray(messages.kind, [...CAMPAIGN_KINDS]), eq(messages.status, "queued"),
	)).orderBy(asc(messages.kind), asc(messages._id)).all();
	let jobs = 0;
	// Every durable job executes one message. Issues are enqueued before last-chance emails.
	for (const ids of chunk(queued.map(({ _id }) => _id), PUBLISH_CHUNK_SIZE) as string[][]) jobs += await enqueueMessages(ids);
	return jobs;
}

export async function queueCampaign(campaignId: string, expectedSchedule?: string) {
	assertSendingEnabled();
	if (!isObjectIdString(campaignId)) throw new Error("Campaign not found");
	await connectDb();
	const domains = await listSesDomains();
	const selected = db.transaction((tx) => {
		const campaign = tx.select().from(campaigns).where(eq(campaigns._id, campaignId)).get();
		if (!campaign) throw new Error("Campaign not found");
		if (expectedSchedule && (campaign.status !== "scheduled" || campaign.scheduledAt?.toISOString() !== expectedSchedule)) {
			throw new Error("Campaign schedule changed");
		}
		if (!QUEUEABLE_STATUSES.has(campaign.status)) throw new Error(`Campaign is already ${campaign.status}`);
		const unresolved = tx.select({ _id: messages._id }).from(messages).where(and(
			eq(messages.campaignId, campaignId), inArray(messages.kind, [...CAMPAIGN_KINDS]),
			inArray(messages.status, ["sending", "unknown"]),
		)).limit(1).get();
		if (unresolved) throw new Error("Campaign has uncertain sends; reconcile them before resuming");
		const newsletter = tx.select().from(newsletters).where(eq(newsletters._id, campaign.newsletterId)).get();
		if (!newsletter) throw new Error("Newsletter not found");
		const problem = getSendProblem({ campaign, newsletter, isDomainVerified: Array.isArray(domains) &&
			domains.some(({ domain, verified }) => domain.toLowerCase() === newsletter.fromEmail.split("@")[1]?.toLowerCase() && verified) });
		if (problem) throw new Error(problem);
		const dormant = campaign.status !== "paused" ? insertCampaignMessages(tx, campaign, newsletter) : 0;
		const [recipients, lastChances] = countCampaignMessages(tx, campaign._id);
		if (recipients + lastChances === 0 && dormant === 0) throw new Error("No active contacts to send to");
		const changed = tx.update(campaigns).set({ status: "sending", stats: setJsonCounter(campaigns.stats, "recipients", recipients),
			lastChance: setJsonCounter(campaigns.lastChance, "recipients", lastChances),
			startedAt: sql`coalesce(${campaigns.startedAt}, ${Date.now()})`, updatedAt: new Date() })
			.where(and(eq(campaigns._id, campaign._id), eq(campaigns.status, campaign.status))).returning({ _id: campaigns._id }).get();
		if (!changed) throw new Error("The campaign changed, refresh and try again");
		return { campaign, newsletter, recipients, dormant };
	}, { behavior: "immediate" });
	try {
		await assignArchiveSlug({ campaign: selected.campaign, newsletter: selected.newsletter });
		const batches = await publishQueuedMessages(campaignId);
		if (batches === 0) await settleCampaign(campaignId);
		return { recipients: selected.recipients, batches, dormant: selected.dormant };
	} catch (error) {
		await pauseCampaign(campaignId, `queueing failed: ${formatError(error)}`);
		throw new Error(`Could not queue the campaign, it is paused: ${formatError(error)}`);
	}
}

export async function sendToMoreContacts(campaignId: string, additional: unknown) {
	assertSendingEnabled();
	if (!isObjectIdString(campaignId)) throw new Error("Campaign not found");
	await connectDb();
	const domains = await listSesDomains();
	const selected = db.transaction((tx) => {
		const campaign = tx.select().from(campaigns).where(eq(campaigns._id, campaignId)).get();
		if (!campaign) throw new Error("Campaign not found");
		if (campaign.status !== "sent") throw new Error("Wait until the current step has gone out");
		const newsletter = tx.select().from(newsletters).where(eq(newsletters._id, campaign.newsletterId)).get();
		if (!newsletter) throw new Error("Newsletter not found");
		const problem = getSendProblem({ campaign, newsletter, isDomainVerified: Array.isArray(domains) &&
			domains.some(({ domain, verified }) => domain.toLowerCase() === newsletter.fromEmail.split("@")[1]?.toLowerCase() && verified) });
		if (problem) throw new Error(problem);
		const [sentSoFar, lastChancesSoFar] = countCampaignMessages(tx, campaignId);
		const audienceLimit = getNextStepLimit({ sentSoFar, additional });
		const dormant = insertCampaignMessages(tx, { ...campaign, audienceLimit: audienceLimit ?? null }, newsletter);
		const [recipients, lastChances] = countCampaignMessages(tx, campaignId);
		if (recipients === sentSoFar && lastChances === lastChancesSoFar && dormant === 0) throw new Error("Everyone has received it already");
		const changed = tx.update(campaigns).set({ status: "sending", audienceLimit: audienceLimit ?? null,
			stats: setJsonCounter(campaigns.stats, "recipients", recipients),
			lastChance: setJsonCounter(campaigns.lastChance, "recipients", lastChances), updatedAt: new Date() })
			.where(and(eq(campaigns._id, campaignId), eq(campaigns.status, "sent"))).returning({ _id: campaigns._id }).get();
		if (!changed) throw new Error("The campaign changed, refresh and try again");
		return { recipients, added: recipients - sentSoFar, dormant };
	}, { behavior: "immediate" });
	try {
		const batches = await publishQueuedMessages(campaignId);
		if (batches === 0) await settleCampaign(campaignId);
		return { ...selected, batches };
	} catch (error) {
		await pauseCampaign(campaignId, `queueing failed: ${formatError(error)}`);
		throw new Error(`Could not queue the next step, the campaign is paused: ${formatError(error)}`);
	}
}

function getMessageContent(message: Message, newsletter: Newsletter, campaign: Campaign | undefined): EmailContent | null {
	if (message.kind === "welcome") return getWelcomeContent(newsletter);
	if (message.kind === "confirmation") return getConfirmationContent(newsletter);
	if (message.kind === "last-chance") return getLastChanceContent(newsletter);
	if (message.kind === "test") {
		const content = message.campaignId ? campaign : getWelcomeContent({ welcome: { ...newsletter.welcome, enabled: true } });
		return content ? { ...content, subject: `[Test] ${content.subject}` } : null;
	}
	return campaign ?? null;
}

function prepareEmail(message: Message, content: EmailContent, newsletter: Newsletter, contact: Pick<Contact, "_id" | "email"> & Partial<Pick<Contact, "confirmationNonce">>) {
	const reference = { contactId: contact._id, newsletterId: newsletter._id };
	const email = buildRecipientEmail({ campaign: content, newsletter, contact,
		messageId: UNTRACKED_KINDS.has(message.kind) ? null : message._id,
		confirmUrl: message.kind === "confirmation" ? getConfirmUrl({ ...reference, confirmationNonce: message.confirmationNonce }) : "",
		keepUrl: message.kind === "last-chance" ? getKeepUrl(reference) : "" });
	const tags = [{ name: "message_id", value: message._id }, { name: "kind", value: message.kind }];
	if (message.campaignId) tags.push({ name: "campaign_id", value: message.campaignId });
	return { ...email, tags, headers: { ...email.headers, "Feedback-ID": getFeedbackId({
		campaignId: message.campaignId, kind: message.kind, newsletterSlug: newsletter.slug }) } };
}

function recordSent(message: Message, sesMessageId: string, sentAt: Date): boolean {
	return db.transaction((tx) => {
		// Feedback can arrive before the SES response. Do not downgrade delivered/bounced/complained.
		const changed = tx.update(messages).set({ status: sql`case when ${messages.status} in ('sending', 'unknown') then 'sent' else ${messages.status} end`,
			sesMessageId, sentAt, error: sql`case when ${messages.status} in ('sending', 'unknown', 'delivered') then null else ${messages.error} end`, updatedAt: sentAt })
			.where(and(eq(messages._id, message._id), isNull(messages.sentAt),
				or(isNull(messages.sesMessageId), eq(messages.sesMessageId, sesMessageId)),
				inArray(messages.status, ["sending", "unknown", "delivered", "bounced", "complained", "failed"])))
			.returning({ _id: messages._id }).get();
		if (!changed) {
			const saved = tx.select({ sesMessageId: messages.sesMessageId, sentAt: messages.sentAt }).from(messages)
				.where(eq(messages._id, message._id)).get();
			return Boolean(saved && saved.sesMessageId === sesMessageId && saved.sentAt !== null);
		}
		if (message.campaignId && isCampaignMessage(message.kind)) incrementCampaignCounter(tx, message.campaignId, message.kind, "sent");
		if (message.kind === "test" && message.campaignId) tx.update(campaigns)
			.set({ testSentAt: sentAt, updatedAt: sentAt }).where(eq(campaigns._id, message.campaignId)).run();
		if (message.contactId && message.kind !== "test") tx.update(contacts).set({ lastSentAt: sentAt,
			...(message.kind === "last-chance" ? { lastChanceAt: sentAt } : {}),
			...(message.kind === "campaign" ? { ignoredIssues: sql`coalesce(${contacts.ignoredIssues}, 0) + 1` } : {}),
			stats: jsonCounter(contacts.stats, "sent"), updatedAt: sentAt }).where(eq(contacts._id, message.contactId)).run();
		return true;
	}, { behavior: "immediate" });
}

async function recordFailed(message: Message, error: unknown, expectedStatus: "queued" | "sending") {
	const changed = db.transaction((tx) => {
		const saved = tx.update(messages).set({ status: "failed", error: formatError(error), updatedAt: new Date() })
			.where(and(eq(messages._id, message._id), eq(messages.status, expectedStatus))).returning({ _id: messages._id }).get();
		if (saved && message.campaignId && isCampaignMessage(message.kind)) incrementCampaignCounter(tx, message.campaignId, message.kind, "failed");
		return Boolean(saved);
	}, { behavior: "immediate" });
	if (changed && message.campaignId && isCampaignMessage(message.kind)) {
		const recent = db.select({ status: messages.status }).from(messages).where(and(
			eq(messages.campaignId, message.campaignId), inArray(messages.kind, [...CAMPAIGN_KINDS]),
			inArray(messages.status, ["failed", "sent", "delivered", "bounced", "complained"]),
		)).orderBy(desc(messages.updatedAt), desc(messages._id)).limit(MAX_CONSECUTIVE_FAILURES).all();
		if (recent.length >= MAX_CONSECUTIVE_FAILURES && recent.every(({ status }) => status === "failed")) {
			await pauseCampaign(message.campaignId, `${MAX_CONSECUTIVE_FAILURES} sends failed in a row`);
		}
	}
	return changed;
}

function isDefiniteRejection(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.message.startsWith("Sending is off")) return true;
	const metadata = "$metadata" in error ? error.$metadata : undefined;
	const status = metadata && typeof metadata === "object" && "httpStatusCode" in metadata ? metadata.httpStatusCode : undefined;
	return DEFINITE_REJECTIONS.has(error.name) || (typeof status === "number" && status >= 400 && status < 500 && status !== 408);
}

async function recordUnknown(message: Message, error: unknown, sesMessageId?: string) {
	db.update(messages).set({ status: "unknown", error: formatError(error), ...(sesMessageId ? { sesMessageId } : {}), updatedAt: new Date() })
		.where(and(eq(messages._id, message._id), eq(messages.status, "sending"))).run();
	const reason = `Delivery outcome unknown. Do not resend without reconciliation: ${formatError(error)}`;
	if (message.campaignId && isCampaignMessage(message.kind)) await pauseCampaign(message.campaignId, reason);
	await sendAlert({ key: `send-unknown-${message._id}`, title: "Email delivery outcome unknown", detail: reason,
		path: message.campaignId ? `/campaigns/${message.campaignId}` : "/contacts", cooldownMinutes: 1 });
}

// Single-message durable executor. Only queued messages may claim sending; expired leases that
// encounter sending/unknown do nothing. Rendering and rate delays occur before the atomic claim.
export async function processMessage(messageId: string): Promise<SendResult> {
	const result = emptySendResult();
	if (!isObjectIdString(messageId)) { result.skipped++; return result; }
	await connectDb();
	const message = db.select().from(messages).where(eq(messages._id, messageId)).get();
	if (!message || message.status !== "queued") { result.skipped++; return result; }
	// Also fence legacy/manual queued records that already carry evidence of SES acceptance.
	if (message.sesMessageId !== null || message.sentAt !== null) { result.skipped++; return result; }
	if (message.deliveryAttempts >= 8 || (message.retryDeadlineAt && message.retryDeadlineAt.getTime() <= Date.now())) {
		if (await recordFailed(message, new Error("Delivery retry budget exhausted"), "queued")) result.failed++;
		if (message.campaignId && isCampaignMessage(message.kind)) await settleCampaign(message.campaignId);
		return result;
	}
	if (!isSendingEnabled()) throw retryAt(new Date(Date.now() + 30_000));
	const campaign = message.campaignId ? db.select().from(campaigns).where(eq(campaigns._id, message.campaignId)).get() : undefined;
	if (isCampaignMessage(message.kind)) {
		if (!campaign || campaign.status !== "sending" || await pauseIfUnhealthy(campaign._id)) { result.skipped++; return result; }
	}
	const newsletter = db.select().from(newsletters).where(eq(newsletters._id, message.newsletterId)).get();
	const contact = message.kind === "test" ? { _id: TEST_CONTACT_ID, email: message.email } :
		message.contactId ? db.select().from(contacts).where(eq(contacts._id, message.contactId)).get() : undefined;
	const requiredStatus = message.kind === "confirmation" ? "pending" : "active";
	const suppressed = db.select({ _id: suppressions._id }).from(suppressions).where(eq(suppressions.email, message.email)).limit(1).get();
	const invalidContact = message.kind !== "test" && (!contact || !("status" in contact) || contact.status !== requiredStatus ||
		!("newsletterId" in contact) || contact.newsletterId !== message.newsletterId || contact.email !== message.email ||
		(message.kind === "confirmation" && (!message.confirmationNonce || !("confirmationNonce" in contact) ||
			contact.confirmationNonce !== message.confirmationNonce)));
	if (invalidContact || suppressed) {
		const changed = db.update(messages).set({ status: "suppressed", updatedAt: new Date() })
			.where(and(eq(messages._id, messageId), eq(messages.status, "queued"))).returning({ _id: messages._id }).get();
		if (changed) result.suppressed++; else result.skipped++;
		if (isCampaignMessage(message.kind) && message.campaignId) await settleCampaign(message.campaignId);
		return result;
	}
	let email: ReturnType<typeof prepareEmail>;
	try {
		if (!newsletter || !contact) throw new Error("Newsletter or email content not found");
		const content = getMessageContent(message, newsletter, campaign);
		if (!content) throw new Error("Newsletter or email content not found");
		const problem = getSendProblem({ campaign: content, newsletter });
		if (problem) throw new Error(problem);
		assertSendingEnabled();
		const domains = await listSesDomains();
		if (!Array.isArray(domains) || !domains.some(({ domain, verified }) =>
			domain.toLowerCase() === newsletter.fromEmail.split("@")[1]?.toLowerCase() && verified)) throw new Error("Verify the sending domain in SES");
		email = prepareEmail(message, content, newsletter, contact);
	} catch (error) {
		if (await recordFailed(message, error, "queued")) result.failed++; else result.skipped++;
		if (isCampaignMessage(message.kind) && message.campaignId) await settleCampaign(message.campaignId);
		return result;
	}
	const now = Date.now();
	const delay = reserveSendSlot();
	if (delay > 0) throw retryAt(new Date(now + delay));
	assertSendingEnabled();
	const claim = db.transaction((tx) => {
		if (isCampaignMessage(message.kind) && (!message.campaignId || !tx.select({ _id: campaigns._id }).from(campaigns)
			.where(and(eq(campaigns._id, message.campaignId), eq(campaigns.status, "sending"))).get())) return "skipped";
		const isSuppressed = tx.select({ _id: suppressions._id }).from(suppressions).where(eq(suppressions.email, message.email)).get();
		const eligibleContact = message.kind === "test" || (message.contactId && tx.select({ _id: contacts._id }).from(contacts).where(and(
			eq(contacts._id, message.contactId), eq(contacts.newsletterId, message.newsletterId),
			eq(contacts.email, message.email), eq(contacts.status, requiredStatus),
			message.kind === "confirmation" ? eq(contacts.confirmationNonce, message.confirmationNonce!) : undefined,
		)).get());
		const status = isSuppressed || !eligibleContact ? "suppressed" : "sending";
		const changed = tx.update(messages).set({ status, provider: mailboxProvider(message.email), error: null,
			...(status === "sending" ? { deliveryAttempts: sql`${messages.deliveryAttempts} + 1` } : {}), updatedAt: new Date() })
			.where(and(eq(messages._id, messageId), eq(messages.status, "queued"),
				message.kind === "confirmation" ? eq(messages.confirmationNonce, message.confirmationNonce!) : undefined,
				isNull(messages.sesMessageId), isNull(messages.sentAt))).returning({ _id: messages._id }).get();
		return changed ? status : "skipped";
	}, { behavior: "immediate" });
	if (claim !== "sending") {
		if (claim === "suppressed") result.suppressed++; else result.skipped++;
		if (isCampaignMessage(message.kind) && message.campaignId) await settleCampaign(message.campaignId);
		return result;
	}
	let delivery: { sesMessageId: string; sentAt: Date };
	try {
		assertSendingEnabled();
		const { sesMessageId } = await sendSesEmail(email);
		if (!sesMessageId) throw new Error("SES returned no message ID; acceptance is unknown");
		delivery = { sesMessageId, sentAt: new Date() };
	} catch (error) {
		if (!isDefiniteRejection(error)) {
			await recordUnknown(message, error);
			result.unknown++;
		} else {
			const action = getSendErrorAction(error);
			if (action === "retry" || (action === "pause" && isCampaignMessage(message.kind))) {
				const requeued = db.update(messages).set({ status: "queued", error: formatError(error), updatedAt: new Date() })
					.where(and(eq(messages._id, messageId), eq(messages.status, "sending"),
						isNull(messages.sesMessageId), isNull(messages.sentAt))).returning({ _id: messages._id }).get();
				if (requeued && action === "retry") throw retryAt(new Date(Date.now() + Math.min(60_000, 1000 * 2 ** message.deliveryAttempts)));
				if (requeued && message.campaignId) await pauseCampaign(message.campaignId, formatError(error));
				result.skipped++;
			} else if (await recordFailed(message, error, "sending")) result.failed++; else result.skipped++;
		}
		if (isCampaignMessage(message.kind) && message.campaignId) await settleCampaign(message.campaignId);
		return result;
	}
	let recorded: boolean;
	try {
		recorded = recordSent(message, delivery.sesMessageId, delivery.sentAt);
	} catch (error) {
		// A database failure after SES accepted is not a transport rejection. Never requeue it
		// or overwrite an identity already bound by feedback while the response was pending.
		db.update(messages).set({ sesMessageId: sql`coalesce(${messages.sesMessageId}, ${delivery.sesMessageId})` })
			.where(and(eq(messages._id, messageId), inArray(messages.status, ["sending", "unknown"]))).run();
		await recordUnknown(message, error);
		throw error;
	}
	if (!recorded) {
		await recordUnknown(message, new Error("SES response does not match the stored delivery identity"));
		result.unknown++;
		return result;
	}
	result.sent++;
	if (isCampaignMessage(message.kind) && message.campaignId) await settleCampaign(message.campaignId);
	return result;
}

export async function sendMessageBatch(messageIds: readonly string[]): Promise<SendResult> {
	assertSendingEnabled();
	const ids = [...new Set(Array.isArray(messageIds) ? messageIds : [])].filter((id) => isObjectIdString(id)).slice(0, MAX_BATCH_MESSAGES);
	const result = emptySendResult();
	for (const id of ids) {
		const sent = await processMessage(id);
		result.sent += sent.sent;
		result.failed += sent.failed;
		result.suppressed += sent.suppressed;
		result.skipped += sent.skipped;
		result.unknown += sent.unknown;
		result.retry ||= sent.retry;
	}
	return result;
}

async function sendTest({ content, newsletter, campaignId, to }: { content: EmailContent; newsletter: Newsletter; campaignId?: string; to: unknown }) {
	const email = normalizeEmail(to);
	if (!email) throw new Error("The test email address is invalid");
	const problem = getSendProblem({ campaign: content, newsletter });
	if (problem) throw new Error(problem);
	assertSendingEnabled();
	const messageId = newId();
	const now = new Date();
	db.insert(messages).values({ _id: messageId, kind: "test", campaignId: campaignId ?? null,
		newsletterId: newsletter._id, contactId: null, email, provider: mailboxProvider(email),
		status: "queued", createdAt: now, updatedAt: now }).run();
	const jobId = await enqueueMessage(messageId);
	return { messageId, queued: true as const, jobId };
}

export async function sendTestEmail({ campaignId, to }: { campaignId: string; to: unknown }) {
	assertSendingEnabled();
	if (!isObjectIdString(campaignId)) throw new Error("Campaign not found");
	await connectDb();
	const campaign = db.select().from(campaigns).where(eq(campaigns._id, campaignId)).get();
	if (!campaign) throw new Error("Campaign not found");
	const newsletter = db.select().from(newsletters).where(eq(newsletters._id, campaign.newsletterId)).get();
	if (!newsletter) throw new Error("Newsletter not found");
	return sendTest({ content: campaign, newsletter, campaignId, to });
}

export async function sendWelcomeTestEmail({ newsletterId, to }: { newsletterId: string; to: unknown }) {
	assertSendingEnabled();
	if (!isObjectIdString(newsletterId)) throw new Error("Newsletter not found");
	await connectDb();
	const newsletter = db.select().from(newsletters).where(eq(newsletters._id, newsletterId)).get();
	if (!newsletter) throw new Error("Newsletter not found");
	const content = getWelcomeContent({ welcome: { ...newsletter.welcome, enabled: true } });
	if (!content) throw new Error("Save a subject and content first");
	return sendTest({ content, newsletter, to });
}

async function alertSignupCap(newsletter: Newsletter) {
	await sendAlert({ key: `welcome-cap:${newsletter.slug}`, title: "Signup emails capped",
		detail: `Over ${LIMITS.welcomeEmailsPer10Minutes} welcome and confirmation emails for ${newsletter.name} in 10 minutes. New signups get none until it slows down.`, path: "/contacts" });
}

type SignupDecision = { type: "queue"; messageId: string } | { type: "skip"; reason: string; newsletter?: Newsletter };

async function queueSignupEmail(kind: SignupKind, input: SignupInput) {
	assertSendingEnabled();
	if (!input.contact) return { skipped: kind === "confirmation" ? "contact is not pending" : "contact is not active" };
	const inputContact = input.contact;
	const contactId = inputContact._id;
	await connectDb();
	// Counts and insert share an immediate transaction, so concurrent signups cannot bypass either cap.
	const decision = db.transaction((tx): SignupDecision => {
		const newsletter = tx.select().from(newsletters).where(eq(newsletters._id, input.newsletter._id)).get();
		if (!newsletter) return { type: "skip", reason: "Newsletter not found" };
		const contact = tx.select().from(contacts).where(and(eq(contacts._id, contactId), eq(contacts.newsletterId, newsletter._id))).get();
		const requiredStatus = kind === "confirmation" ? "pending" : "active";
		if (!contact || contact.status !== requiredStatus) return { type: "skip", reason: `contact is not ${requiredStatus}` };
		// Public resubscriptions need confirmation even when new signups use single opt-in.
		if (kind === "confirmation" && !contact.confirmationNonce) return { type: "skip", reason: "contact has no current confirmation" };
		if (kind === "confirmation" && (!("confirmationNonce" in inputContact) || inputContact.confirmationNonce !== contact.confirmationNonce)) {
			return { type: "skip", reason: "contact confirmation changed" };
		}
		const content = kind === "welcome" ? getWelcomeContent(newsletter) : getConfirmationContent(newsletter);
		if (!content) return { type: "skip", reason: "welcome email is off" };
		if (tx.select({ _id: suppressions._id }).from(suppressions).where(eq(suppressions.email, contact.email)).get()) return { type: "skip", reason: "suppressed" };
		const cutoff = new Date(Date.now() - WELCOME_WINDOW_MS);
		// An unbound legacy in-flight/accepted row cannot be safely assigned to any generation.
		if (kind === "confirmation" && tx.select({ _id: messages._id }).from(messages).where(and(
			eq(messages.kind, kind), eq(messages.contactId, contactId), isNull(messages.confirmationNonce),
			or(inArray(messages.status, ["sending", "unknown"]), and(eq(messages.status, "queued"),
				or(isNotNull(messages.sesMessageId), isNotNull(messages.sentAt)))),
		)).limit(1).get()) return { type: "skip", reason: "delivery is unresolved" };
		// Timestamps cannot distinguish same-millisecond resubscriptions. Never attach legacy rows to a current nonce.
		const prior = tx.select().from(messages).where(and(eq(messages.kind, kind), eq(messages.contactId, contactId),
			kind === "confirmation" ? eq(messages.confirmationNonce, contact.confirmationNonce!) : undefined))
			.orderBy(desc(messages.createdAt), desc(messages._id)).all();
		const unresolved = prior.some(({ status, sesMessageId, sentAt }) => status === "sending" || status === "unknown" ||
			(status === "queued" && (sesMessageId !== null || sentAt !== null)));
		if (unresolved) return { type: "skip", reason: "delivery is unresolved" };
		// Recover a pending publication regardless of age. A cooldown never creates a second logical email.
		const queued = prior.find(({ status }) => status === "queued");
		if (queued) return { type: "queue", messageId: queued._id };
		// Every remaining result is completed and known. Only these rows participate in resend caps.
		const blocked = kind === "welcome" ? prior.length > 0 :
			prior.length >= MAX_CONFIRMATIONS_PER_CONTACT || prior.some(({ createdAt }) => createdAt >= cutoff);
		if (blocked) return { type: "skip", reason: "already sent" };
		const recent = tx.select({ total: count() }).from(messages).where(and(
			eq(messages.newsletterId, newsletter._id), inArray(messages.kind, [...SIGNUP_KINDS]), gte(messages.createdAt, cutoff),
		)).get()?.total ?? 0;
		if (recent >= LIMITS.welcomeEmailsPer10Minutes) return { type: "skip", reason: "rate limited", newsletter };
		const problem = getSendProblem({ campaign: content, newsletter });
		if (problem) {
			console.warn(`[sending] ${kind} email for ${newsletter.slug} not sent: ${problem}`);
			return { type: "skip", reason: problem };
		}
		const messageId = newId();
		const now = new Date();
		tx.insert(messages).values({ _id: messageId, kind, newsletterId: newsletter._id, contactId,
			confirmationNonce: kind === "confirmation" ? contact.confirmationNonce : null,
			email: contact.email, provider: mailboxProvider(contact.email), status: "queued", createdAt: now, updatedAt: now }).run();
		return { type: "queue", messageId };
	}, { behavior: "immediate" });
	if (decision.type === "skip") {
		if (decision.reason === "rate limited" && decision.newsletter) await alertSignupCap(decision.newsletter);
		return { skipped: decision.reason };
	}
	assertSendingEnabled();
	const jobId = await enqueueMessage(decision.messageId);
	return { messageId: decision.messageId, queued: true as const, jobId };
}

export async function queueWelcomeEmail(input: SignupInput) {
	return queueSignupEmail("welcome", input);
}

export async function queueConfirmationEmail(input: SignupInput) {
	return queueSignupEmail("confirmation", input);
}
