"use server";

import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, connectDb } from "@/db";
import { campaigns, newsletters } from "@/db/schema";
import { notifyActivity } from "@/lib/alerts";
import { PUBLISHED_STATUSES, revalidateArchive } from "@/lib/archive-data";
import { requireSession } from "@/lib/auth";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { getScheduleProblem } from "@/lib/schedule";
import { publishScheduledSend } from "@/lib/scheduling";
import { getCleanupPreview, queueCampaign, sendTestEmail, sendToMoreContacts } from "@/lib/sending";
import { getSendProblem } from "@/lib/sending-rules";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { firstImageUrl } from "@/lib/thumbnail";
import { isObjectIdString, MAX_BODY_BYTES } from "@/lib/validation";

type Campaign = typeof campaigns.$inferSelect;
type AudienceOptions = { audienceLimit?: unknown };
const MAX_SUBJECT_LENGTH = 200;
const COPY_SUFFIX = " (copy)";
const EDITABLE_STATUSES = ["draft", "scheduled"] as const;

function readAudienceLimit(value: unknown) {
	const limit = Number(value);
	return Number.isInteger(limit) && limit > 0 ? limit : null;
}

function errorMessage(error: unknown, fallback: string) {
	return error instanceof Error ? error.message : fallback;
}

function isUniqueConflict(error: unknown): boolean {
	return error instanceof Error && (error.message.includes("UNIQUE constraint failed") || isUniqueConflict(error.cause));
}

function notifySend(campaign: Campaign, action: string) {
	return notifyActivity([`${action}: ${campaign.subject || "(no subject)"}`, `${getAppUrl()}/campaigns/${campaign._id}`]);
}

function formatCount(count: number) {
	return count.toLocaleString("en-US");
}

async function findCampaign(id: string) {
	await requireSession();
	if (!isObjectIdString(id)) return null;
	await connectDb();
	return db.select().from(campaigns).where(eq(campaigns._id, id)).get() ?? null;
}

export async function createCampaign(newsletterId: string) {
	await requireSession();
	if (!isObjectIdString(newsletterId)) return { error: "Newsletter not found" };
	await connectDb();
	if (!db.select({ _id: newsletters._id }).from(newsletters).where(eq(newsletters._id, newsletterId)).get()) {
		return { error: "Newsletter not found" };
	}
	const now = new Date();
	const campaign = db.insert(campaigns).values({
		_id: randomBytes(12).toString("hex"), newsletterId, createdAt: now, updatedAt: now,
	}).returning().get();
	revalidatePath("/campaigns");
	redirect(`/campaigns/${campaign._id}`);
}

// Include the status in the write so an editor cannot overwrite a campaign that just started.
export async function saveCampaign(id: string, values: { body?: unknown; subject?: unknown; previewText?: unknown }) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (campaign.status !== "draft" && campaign.status !== "scheduled") return { error: "Only drafts can be edited" };
	const body = String(values?.body ?? "");
	const bytes = Buffer.byteLength(body, "utf8");
	if (bytes > MAX_BODY_BYTES) {
		return { error: `The content is ${Math.ceil(bytes / 1000)} KB. The limit is ${MAX_BODY_BYTES / 1000} KB.` };
	}
	const format = campaign.format === "markdown" ? "rich" : campaign.format;
	const thumbnailUrl = firstImageUrl({ format, html: body, markdown: campaign.markdown });
	const saved = db.update(campaigns).set({
		subject: String(values?.subject ?? "").slice(0, MAX_SUBJECT_LENGTH).trim(),
		previewText: String(values?.previewText ?? "").slice(0, 300).trim(),
		format, html: body, thumbnailUrl: thumbnailUrl || null, updatedAt: new Date(),
	}).where(and(eq(campaigns._id, id), inArray(campaigns.status, EDITABLE_STATUSES))).returning({ _id: campaigns._id }).get();
	if (!saved) return { error: "This campaign is already sending" };
	revalidatePath("/campaigns");
	return { ok: true };
}

async function runSend<T>(send: () => Promise<T>) {
	try {
		const result = await send();
		return { ok: true as const, result };
	} catch (error) {
		console.error("[campaigns] Send failed:", error);
		return { error: errorMessage(error, "Sending failed") };
	}
}

export async function sendTestCampaign(id: string) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!isSendingEnabled()) return { error: "Sending is off" };
	const result = await runSend(() => sendTestEmail({ campaignId: campaign._id, to: process.env.ADMIN_EMAIL }));
	revalidatePath(`/campaigns/${id}`);
	return result;
}

// Keep the existing schedule until the shared sender commits the sending transition.
export async function sendCampaign(id: string, { audienceLimit }: AudienceOptions = {}) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (campaign.status !== "draft" && campaign.status !== "scheduled") return { error: "Already sent" };
	if (!isSendingEnabled()) return { error: "Sending is off" };
	const updatedAt = new Date(Math.max(Date.now(), campaign.updatedAt.getTime() + 1));
	const saved = db.update(campaigns).set({
		audienceLimit: readAudienceLimit(audienceLimit), updatedAt,
	}).where(and(eq(campaigns._id, id), eq(campaigns.status, campaign.status), eq(campaigns.updatedAt, campaign.updatedAt))).returning().get();
	if (!saved) return { error: "This campaign is already sending" };
	const result = await runSend(() => queueCampaign(campaign._id));
	if (result.error) {
		// Restore only our reservation. A worker transition or later edit keeps its own state.
		db.update(campaigns).set({
			audienceLimit: campaign.audienceLimit,
			updatedAt: new Date(Math.max(Date.now(), updatedAt.getTime() + 1)),
		}).where(and(
			eq(campaigns._id, id), eq(campaigns.status, saved.status),
			saved.scheduledAt === null ? isNull(campaigns.scheduledAt) : eq(campaigns.scheduledAt, saved.scheduledAt),
			saved.audienceLimit === null ? isNull(campaigns.audienceLimit) : eq(campaigns.audienceLimit, saved.audienceLimit),
			eq(campaigns.updatedAt, updatedAt),
		)).run();
	}
	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	if (result.ok) {
		revalidateArchive();
		await notifySend(saved, saved.audienceLimit ? `Send started (first ${formatCount(saved.audienceLimit)})` : "Send started");
	}
	return result;
}

export async function scheduleCampaign(id: string, { scheduledAt, audienceLimit }: AudienceOptions & { scheduledAt?: unknown } = {}) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (campaign.status !== "draft" && campaign.status !== "scheduled") return { error: "Already sent" };
	if (!isSendingEnabled()) return { error: "Sending is off" };
	const at = scheduledAt instanceof Date ? new Date(scheduledAt.getTime())
		: new Date(typeof scheduledAt === "string" || typeof scheduledAt === "number" ? scheduledAt : NaN);
	const problem = getScheduleProblem(at);
	if (problem) return { error: problem };
	const newsletter = db.select().from(newsletters).where(eq(newsletters._id, campaign.newsletterId)).get();
	const sendProblem = getSendProblem({ campaign, newsletter });
	if (sendProblem) return { error: sendProblem };
	const limit = readAudienceLimit(audienceLimit);
	const updatedAt = new Date(Math.max(Date.now(), campaign.updatedAt.getTime() + 1));
	const saved = db.update(campaigns).set({
		status: "scheduled", scheduledAt: at, audienceLimit: limit, updatedAt,
	}).where(and(eq(campaigns._id, id), eq(campaigns.status, campaign.status), eq(campaigns.updatedAt, campaign.updatedAt))).returning().get();
	if (!saved) return { error: "The campaign changed, refresh and try again" };
	try {
		await publishScheduledSend({ campaignId: campaign._id, scheduledAt: at });
	} catch (error) {
		console.error("[campaigns] Scheduling failed:", error);
		db.update(campaigns).set({
			status: campaign.status, scheduledAt: campaign.scheduledAt, audienceLimit: campaign.audienceLimit,
			updatedAt: new Date(Math.max(Date.now(), updatedAt.getTime() + 1)),
		}).where(and(
			eq(campaigns._id, id), eq(campaigns.status, "scheduled"), eq(campaigns.scheduledAt, at),
			limit === null ? isNull(campaigns.audienceLimit) : eq(campaigns.audienceLimit, limit),
			eq(campaigns.updatedAt, updatedAt),
		)).run();
		return { error: `Couldn't schedule it: ${errorMessage(error, "Scheduling failed")}` };
	}
	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	const when = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
	await notifySend(saved, `Send scheduled for ${when}${limit ? ` (first ${formatCount(limit)})` : ""}`);
	return { ok: true };
}

export async function unscheduleCampaign(id: string) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	const saved = db.update(campaigns).set({ status: "draft", scheduledAt: null, updatedAt: new Date() })
		.where(and(eq(campaigns._id, id), eq(campaigns.status, "scheduled"))).returning({ _id: campaigns._id }).get();
	if (!saved) return { error: "It isn't scheduled anymore" };
	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

export async function previewCleanup(id: string) {
	await requireSession();
	if (!isObjectIdString(id)) return { error: "Campaign not found" };
	try {
		return await getCleanupPreview(id);
	} catch (error) {
		console.error("[campaigns] Cleanup preview failed:", error);
		return { error: errorMessage(error, "Couldn't count the list cleanup") };
	}
}

export async function sendCampaignToMore(id: string, { additional }: { additional?: unknown } = {}) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!isSendingEnabled()) return { error: "Sending is off" };
	const more = readAudienceLimit(additional);
	const result = await runSend(() => sendToMoreContacts(campaign._id, more ?? undefined));
	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	if (result.ok) await notifySend(campaign, `Send to more started (${more ? `next ${formatCount(more)}` : "everyone left"})`);
	return result;
}

export async function resumeCampaign(id: string) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (campaign.status !== "paused") return { error: "Only paused campaigns can resume" };
	if (!isSendingEnabled()) return { error: "Sending is off" };
	const result = await runSend(() => queueCampaign(campaign._id));
	revalidatePath(`/campaigns/${id}`);
	if (result.ok) await notifySend(campaign, "Send resumed");
	return result;
}

export async function pauseCampaign(id: string) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	db.update(campaigns).set({ status: "paused", updatedAt: new Date() })
		.where(and(eq(campaigns._id, id), eq(campaigns.status, "sending"))).run();
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

export async function toggleArchivePin(id: string) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!campaign.archiveSlug || campaign.archiveListed === false) return { error: "Not listed on the archive" };
	db.update(campaigns).set({ archivePinned: sql`not ${campaigns.archivePinned}`, updatedAt: new Date() })
		.where(eq(campaigns._id, id)).run();
	revalidatePath(`/campaigns/${id}`);
	revalidateArchive();
	return { ok: true };
}

export async function duplicateCampaign(id: string) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	const now = new Date();
	const copy = db.insert(campaigns).values({
		_id: randomBytes(12).toString("hex"), newsletterId: campaign.newsletterId,
		subject: campaign.subject ? `${campaign.subject.slice(0, MAX_SUBJECT_LENGTH - COPY_SUFFIX.length)}${COPY_SUFFIX}` : "",
		previewText: campaign.previewText, format: campaign.format, markdown: campaign.markdown, html: campaign.html,
		thumbnailUrl: campaign.thumbnailUrl, source: campaign.source === "api" ? "api" : "dashboard",
		createdAt: now, updatedAt: now,
	}).returning().get();
	revalidatePath("/campaigns");
	redirect(`/campaigns/${copy._id}`);
}

// Keep content and reports when discarding. Canceled hides the draft and stops scheduled jobs.
export async function discardCampaign(id: string) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (campaign.status !== "draft" && campaign.status !== "scheduled") return { error: "Only drafts can be discarded" };
	const saved = db.update(campaigns).set({ status: "canceled", scheduledAt: null, updatedAt: new Date() })
		.where(and(eq(campaigns._id, id), inArray(campaigns.status, EDITABLE_STATUSES))).returning({ _id: campaigns._id }).get();
	if (!saved) return { error: "This campaign is already sending" };
	revalidatePath("/");
	revalidatePath("/campaigns");
	return { ok: true };
}

export async function updateArchiveSlug(id: string, value: unknown) {
	const campaign = await findCampaign(id);
	if (!campaign || campaign.status === "canceled") return { error: "Campaign not found" };
	const slug = String(value ?? "").trim().toLowerCase().replace(/-+$/, "");
	const isPublished = PUBLISHED_STATUSES.includes(campaign.status);
	if (!slug && isPublished) return { error: "A sent issue needs a URL" };
	if (slug && !ARCHIVE_SLUG_PATTERN.test(slug)) return { error: "Use lowercase letters, digits and hyphens" };
	if (slug === (campaign.archiveSlug ?? "")) return { ok: true, archiveSlug: slug };
	if (slug && db.select({ _id: campaigns._id }).from(campaigns)
		.where(and(ne(campaigns._id, id), eq(campaigns.archiveSlug, slug))).get()) {
		return { error: "Another issue uses this URL" };
	}
	try {
		db.update(campaigns).set({ archiveSlug: slug || null, updatedAt: new Date() }).where(eq(campaigns._id, id)).run();
	} catch (error) {
		if (isUniqueConflict(error)) return { error: "Another issue uses this URL" };
		throw error;
	}
	revalidatePath(`/campaigns/${id}`);
	if (isPublished) {
		revalidatePath("/campaigns");
		revalidateArchive();
	}
	return { ok: true, archiveSlug: slug };
}
