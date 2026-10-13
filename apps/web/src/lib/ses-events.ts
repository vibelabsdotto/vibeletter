import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { connectDb, db } from "@/db";
import { campaigns, contacts, events, messages, suppressions } from "@/db/schema";
import { sendAlert } from "@/lib/alerts";
import { getCampaignPauseReason } from "@/lib/sending-rules";
import { getSesEventPlan, getTrackingPlan } from "@/lib/ses-event-mapping";
import { isLikelyScanner } from "@/lib/tracking";

export { getSesEventPlan } from "@/lib/ses-event-mapping";

type Message = typeof messages.$inferSelect;
type Contact = typeof contacts.$inferSelect;
type Store = Pick<typeof db, "select" | "insert" | "update">;
type FirstField = "deliveredAt" | "openedAt" | "clickedAt" | "bouncedAt" | "complainedAt";
type Plan = {
	type: string; sesMessageId?: string | null; messageId?: string | null; email?: string | null;
	occurredAt: Date; firsts: { field: FirstField; stat?: string; contactStat?: string }[];
	status: { from: Message["status"][]; to: Message["status"]; stat?: string } | null;
	error: string | null; engagement: { lastOpenAt?: Date; lastClickAt?: Date } | null;
	suppression: { emails: string[]; reason: "bounce" | "complaint"; detail: string;
		contactStatus: Contact["status"]; contactStatusFrom: Contact["status"][] } | null;
	data?: Record<string, unknown>;
};
function newId(): string { return randomBytes(12).toString("hex"); }

function findMessage(store: Store, plan: Plan): Message | undefined {
	if (plan.sesMessageId) {
		const found = store.select().from(messages).where(eq(messages.sesMessageId, plan.sesMessageId)).get();
		if (found) return found;
	}
	if (!plan.messageId) return;
	const message = store.select().from(messages).where(eq(messages._id, plan.messageId)).get();
	if (!message || (message.sesMessageId && plan.sesMessageId && message.sesMessageId !== plan.sesMessageId)) return;
	// The message_id tag also covers feedback arriving before the sender saves SES's ID.
	if (!message.sesMessageId && plan.sesMessageId) {
		store.update(messages).set({ sesMessageId: plan.sesMessageId, updatedAt: new Date() })
			.where(and(eq(messages._id, message._id), isNull(messages.sesMessageId))).run();
	}
	return message;
}

function jsonIncrements(column: SQLWrapper, increments: Record<string, number>): SQL {
	let value: SQL = sql`coalesce(${column}, '{}')`;
	for (const [key, amount] of Object.entries(increments)) {
		const path = `$.${key}`;
		value = sql`json_set(${value}, ${path}, coalesce(json_extract(${column}, ${path}), 0) + ${amount})`;
	}
	return value;
}

function maxDate(column: SQLWrapper, at: Date): SQL {
	return sql`max(coalesce(${column}, 0), ${at.getTime()})`;
}

function recordAcceptance(store: Store, message: Message, plan: Plan, sesEvent: Record<string, unknown>): void {
	if (!plan.sesMessageId || message.status === "suppressed") return;
	const mail = sesEvent.mail as { timestamp?: unknown } | undefined;
	const timestamp = typeof mail?.timestamp === "string" ? new Date(mail.timestamp) : plan.occurredAt;
	const at = Number.isFinite(timestamp.getTime()) ? timestamp : plan.occurredAt;
	const claimed = store.update(messages).set({ sentAt: at, updatedAt: new Date(),
		status: sql`case when ${messages.status} in ('queued', 'sending', 'unknown') then 'sent' else ${messages.status} end`,
	}).where(and(eq(messages._id, message._id), isNull(messages.sentAt)))
		.returning({ _id: messages._id }).get();
	if (!claimed) return;
	// This shares the sender's sentAt first-claim. Early feedback or transport-unknown
	// outcomes therefore count once, and the later SendEmail response cannot count twice.
	if (message.campaignId && (message.kind === "campaign" || message.kind === "last-chance")) {
		const counters = message.kind === "last-chance"
			? { lastChance: jsonIncrements(campaigns.lastChance, { sent: 1 }) }
			: { stats: jsonIncrements(campaigns.stats, { sent: 1 }) };
		store.update(campaigns).set({ ...counters, updatedAt: new Date() }).where(eq(campaigns._id, message.campaignId)).run();
	}
	if (message.kind === "test" && message.campaignId) store.update(campaigns)
		.set({ testSentAt: at, updatedAt: new Date() }).where(eq(campaigns._id, message.campaignId)).run();
	if (message.contactId && message.kind !== "test") store.update(contacts).set({
		lastSentAt: maxDate(contacts.lastSentAt, at), stats: jsonIncrements(contacts.stats, { sent: 1 }),
		...(message.kind === "last-chance" ? { lastChanceAt: maxDate(contacts.lastChanceAt, at) } : {}),
		...(message.kind === "campaign" ? { ignoredIssues: sql`coalesce(${contacts.ignoredIssues}, 0) + 1` } : {}),
		updatedAt: new Date(),
	}).where(eq(contacts._id, message.contactId)).run();
}

// The first-date claim and every counter move share a SQLite transaction. A failed write
// rolls back the claim too, so an SNS retry cannot lose or double-count feedback.
function applyMessageUpdates(store: Store, message: Message, plan: Plan): void {
	const campaignInc: Record<string, number> = {};
	const contactInc: Record<string, number> = {};
	for (const { field, stat, contactStat } of plan.firsts) {
		const claimed = store.update(messages).set({ [field]: plan.occurredAt, updatedAt: new Date() })
			.where(and(eq(messages._id, message._id), isNull(messages[field])))
			.returning({ _id: messages._id }).get();
		if (!claimed) continue;
		if (stat) campaignInc[stat] = (campaignInc[stat] ?? 0) + 1;
		if (contactStat) contactInc[contactStat] = (contactInc[contactStat] ?? 0) + 1;
	}
	if (plan.status) {
		// A signed provider event resolves a transport-unknown/in-flight outcome too.
		const from = [...new Set([...plan.status.from, "sending", "unknown"])] as Message["status"][];
		const changed = store.update(messages).set({ status: plan.status.to, updatedAt: new Date() })
			.where(and(eq(messages._id, message._id), inArray(messages.status, from)))
			.returning({ _id: messages._id }).get();
		if (changed && plan.status.stat) campaignInc[plan.status.stat] = (campaignInc[plan.status.stat] ?? 0) + 1;
	}
	if (plan.error) store.update(messages).set({ error: plan.error.slice(0, 500), updatedAt: new Date() })
		.where(eq(messages._id, message._id)).run();
	if ((message.kind === "campaign" || message.kind === "last-chance") && message.campaignId && Object.keys(campaignInc).length) {
		const counters = message.kind === "last-chance"
			? { lastChance: jsonIncrements(campaigns.lastChance, campaignInc) }
			: { stats: jsonIncrements(campaigns.stats, campaignInc) };
		store.update(campaigns).set({ ...counters, updatedAt: new Date() }).where(eq(campaigns._id, message.campaignId)).run();
	}
	if (message.contactId && (plan.engagement || Object.keys(contactInc).length)) {
		store.update(contacts).set({
			...(Object.keys(contactInc).length ? { stats: jsonIncrements(contacts.stats, contactInc) } : {}),
			...(plan.engagement ? { ignoredIssues: 0, lastEngagedAt: maxDate(contacts.lastEngagedAt, plan.occurredAt) } : {}),
			...(plan.engagement?.lastOpenAt ? { lastOpenAt: maxDate(contacts.lastOpenAt, plan.engagement.lastOpenAt) } : {}),
			...(plan.engagement?.lastClickAt ? { lastClickAt: maxDate(contacts.lastClickAt, plan.engagement.lastClickAt) } : {}),
			updatedAt: new Date(),
		}).where(eq(contacts._id, message.contactId)).run();
	}
}

function suppress(store: Store, suppression: NonNullable<Plan["suppression"]>): void {
	const { emails, reason, detail, contactStatus, contactStatusFrom } = suppression;
	if (!emails.length) return;
	for (const email of emails) {
		const insert = store.insert(suppressions).values({ _id: newId(), email, reason, detail, createdAt: new Date(), updatedAt: new Date() });
		// A complaint outranks bounce/manual. A bounce never overwrites a complaint.
		if (reason === "complaint") insert.onConflictDoUpdate({ target: suppressions.email, set: { reason, detail, updatedAt: new Date() } }).run();
		else insert.onConflictDoNothing({ target: suppressions.email }).run();
	}
	store.update(contacts).set({ status: contactStatus, updatedAt: new Date() })
		.where(and(inArray(contacts.email, emails), inArray(contacts.status, contactStatusFrom))).run();
}

function pauseIfUnhealthy(store: Store, message: Message | undefined): string | null {
	if (!message?.campaignId || (message.kind !== "campaign" && message.kind !== "last-chance")) return null;
	const campaign = store.select().from(campaigns).where(eq(campaigns._id, message.campaignId)).get();
	if (!campaign || campaign.status !== "sending") return null;
	const reason = getCampaignPauseReason(campaign.stats, campaign.lastChance);
	if (!reason) return null;
	const changed = store.update(campaigns).set({ status: "paused", updatedAt: new Date() })
		.where(and(eq(campaigns._id, campaign._id), eq(campaigns.status, "sending")))
		.returning({ _id: campaigns._id }).get();
	return changed ? String(reason) : null;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export async function recordEngagement({ messageId, type, userAgent }: { messageId: string; type: string; userAgent?: string | null }): Promise<void> {
	if (type !== "Open" && type !== "Click") return;
	await connectDb();
	db.transaction((tx) => {
		const message = tx.select().from(messages).where(eq(messages._id, messageId)).get();
		if (!message || (type === "Click" && isLikelyScanner({ userAgent, sentAt: message.sentAt }))) return;
		applyMessageUpdates(tx, message, getTrackingPlan(type) as Plan);
	}, { behavior: "immediate" });
}

export async function handleSesEvent(sesEvent: Record<string, unknown>, { notificationId }: { notificationId?: string } = {}): Promise<{ handled: boolean; messageId?: string | null }> {
	const plan = getSesEventPlan(sesEvent) as Plan | null;
	if (!plan) return { handled: false };
	await connectDb();
	const result = db.transaction((tx) => {
		// Keep the existing SNS key so previously recorded feedback stays deduplicated.
		// SNS MessageId identifies a notification, not mail.messageId, which is shared
		// by Send, Delivery, Bounce and other distinct events for the same SES send.
		// Direct calls use raw canonical content, never the fallback occurredAt clock.
		const _id = createHash("sha256").update(notificationId ? `sns:${notificationId}` : `ses:${canonicalJson(sesEvent)}`).digest("hex").slice(0, 24);
		const claimed = tx.insert(events).values({ _id, type: plan.type, sesMessageId: plan.sesMessageId,
			email: plan.email, occurredAt: plan.occurredAt, data: plan.data, createdAt: new Date(), updatedAt: new Date() })
			.onConflictDoNothing({ target: events._id }).returning({ _id: events._id }).get();
		// Claim every supported event before even findMessage can attach the provider ID.
		// Duplicates must not restore removed suppressions, change a new try or alert.
		if (!claimed) return null;
		const message = findMessage(tx, plan);
		if (message) {
			tx.update(events).set({ messageId: message._id, campaignId: message.campaignId,
				email: plan.email ?? message.email }).where(eq(events._id, _id)).run();
			recordAcceptance(tx, message, plan, sesEvent);
			applyMessageUpdates(tx, message, plan);
		}
		if (plan.suppression) suppress(tx, plan.suppression);
		return { messageId: message?._id ?? null, campaignId: message?.campaignId ?? null, pauseReason: pauseIfUnhealthy(tx, message) };
	}, { behavior: "immediate" });
	if (!result) return { handled: true };
	if (plan.suppression?.reason === "complaint") await sendAlert({ key: "complaints", title: "Spam complaint",
		detail: `${plan.suppression.emails.join(", ")} marked an email as spam. Contacts are suppressed.`,
		path: result.campaignId ? `/campaigns/${result.campaignId}` : "" });
	if (result.pauseReason) await sendAlert({ key: `campaign-paused-feedback-${result.campaignId}`, title: "Campaign paused",
		detail: `${result.pauseReason} is over the limit`, path: `/campaigns/${result.campaignId}`, cooldownMinutes: 1 });
	return { handled: true, messageId: result.messageId };
}
