import "server-only";
import { and, eq } from "drizzle-orm";
import { RetryAfterError } from "liteque";
import { connectDb, db } from "@/db";
import { campaigns } from "@/db/schema";
import { sendAlert } from "@/lib/alerts";
import { isSendingEnabled } from "@/lib/config";
import { queueCampaign } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";
import { cancelScheduledCampaign, enqueueScheduledCampaign } from "@/queue";

export { cancelScheduledCampaign };

export async function publishScheduledSend({ campaignId, scheduledAt }: { campaignId: string; scheduledAt: Date; now?: number }) {
	if (!isObjectIdString(campaignId) || !Number.isFinite(scheduledAt.getTime())) throw new Error("Invalid campaign schedule");
	const jobId = await enqueueScheduledCampaign(campaignId, scheduledAt);
	return { jobId, queued: true as const };
}

/** Only the standalone worker calls this. Exact-time/status checks also happen in the send transaction. */
export async function runScheduledSend({ campaignId, scheduledAt }: { campaignId: string; scheduledAt: string }) {
	if (!isObjectIdString(campaignId) || typeof scheduledAt !== "string" || !Number.isFinite(new Date(scheduledAt).getTime())) return { skipped: "invalid job" };
	await connectDb();
	const campaign = db.select().from(campaigns).where(eq(campaigns._id, campaignId)).get();
	if (campaign?.status !== "scheduled" || campaign.scheduledAt?.toISOString() !== scheduledAt) return { skipped: "not scheduled for this time anymore" };
	const remaining = campaign.scheduledAt.getTime() - Date.now();
	if (remaining > 0) throw new RetryAfterError(remaining);
	if (!isSendingEnabled()) throw new RetryAfterError(30_000);
	try {
		return { started: true as const, ...(await queueCampaign(campaignId, scheduledAt)) };
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Scheduled send failed";
		if (reason === "Campaign schedule changed") return { skipped: "not scheduled for this time anymore" };
		const changed = db.update(campaigns).set({ status: "draft", scheduledAt: null, updatedAt: new Date() }).where(and(
			eq(campaigns._id, campaignId), eq(campaigns.status, "scheduled"), eq(campaigns.scheduledAt, new Date(scheduledAt)),
		)).returning({ _id: campaigns._id }).get();
		if (changed) await sendAlert({ key: `scheduled-send-${campaignId}`, title: "Scheduled send didn't start",
			detail: `${reason}. "${campaign.subject || "Untitled"}" is a draft again.`, path: `/campaigns/${campaignId}`, cooldownMinutes: 1 });
		return { failed: reason };
	}
}

export const runScheduledCampaign = runScheduledSend;
