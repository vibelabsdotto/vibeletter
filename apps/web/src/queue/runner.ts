import { and, eq, inArray } from "drizzle-orm";
import { RetryAfterError, Runner, type DequeuedJob, type DequeuedJobError } from "liteque";
import { connectDb, db } from "@/db";
import { campaigns, messages } from "@/db/schema";
import { processAlert, recordAlertJobError } from "@/lib/alert-delivery";
import { runScheduledSend } from "@/lib/scheduling";
import { processMessage } from "@/lib/sending";
import { enqueueMessage, enqueueScheduledCampaign, getNativeQueue, jobSchema, type JobPayload } from "./index";
import { getQueueDatabase } from "./connection";

/** One worker on the same persistent local volume. No package heartbeat or exactly-once SES claim. */
export async function reconcileQueue({ recoverInterrupted = false }: { recoverInterrupted?: boolean } = {}) {
	await connectDb();
	if (recoverInterrupted) {
		const interrupted = db.update(messages).set({ status: "unknown", error: "Worker interrupted after claiming delivery. Reconcile SES feedback; do not resend.", updatedAt: new Date() })
			.where(eq(messages.status, "sending")).returning({ campaignId: messages.campaignId }).all();
		const ids = [...new Set(interrupted.flatMap(({ campaignId }) => campaignId ? [campaignId] : []))];
		if (ids.length) db.update(campaigns).set({ status: "paused", updatedAt: new Date() })
			.where(and(inArray(campaigns._id, ids), eq(campaigns.status, "sending"))).run();
	}
	const nativeKeys = new Set((getQueueDatabase().$client.prepare("SELECT idempotencyKey FROM tasks WHERE queue = 'vibeletter'").all() as { idempotencyKey: string | null }[])
		.flatMap(({ idempotencyKey }) => idempotencyKey ? [idempotencyKey] : []));
	const campaignState = new Map(db.select({ id: campaigns._id, status: campaigns.status }).from(campaigns).all().map(({ id, status }) => [id, status]));
	const queued = db.select({ id: messages._id, kind: messages.kind, campaignId: messages.campaignId }).from(messages).where(eq(messages.status, "queued")).all();
	let repairedMessages = 0;
	for (const message of queued) {
		if (nativeKeys.has(`message:${message.id}`)) continue;
		if (["campaign", "last-chance"].includes(message.kind) && (!message.campaignId || campaignState.get(message.campaignId) !== "sending")) continue;
		await enqueueMessage(message.id);
		repairedMessages++;
	}
	let repairedSchedules = 0;
	for (const campaign of db.select({ id: campaigns._id, scheduledAt: campaigns.scheduledAt }).from(campaigns).where(eq(campaigns.status, "scheduled")).all()) {
		if (!campaign.scheduledAt || nativeKeys.has(`schedule:${campaign.id}:${campaign.scheduledAt.toISOString()}`)) continue;
		await enqueueScheduledCampaign(campaign.id, campaign.scheduledAt);
		repairedSchedules++;
	}
	return { repairedMessages, repairedSchedules };
}

async function runJob(job: DequeuedJob<JobPayload>): Promise<void> {
	if (job.abortSignal.aborted) throw new Error("Worker job aborted");
	if (job.data.kind === "scheduled-campaign") {
		const result = await runScheduledSend(job.data);
		if ("failed" in result) throw new Error(result.failed);
		return;
	}
	if (job.data.kind === "send-alert") {
		await processAlert(job.data);
		return;
	}
	const message = db.select().from(messages).where(eq(messages._id, job.data.messageId)).get();
	if (message && ["failed", "unknown", "sending"].includes(message.status)) throw new Error(message.error || "Delivery requires operator reconciliation");
	const result = await processMessage(job.data.messageId);
	// Retain terminal delivery failures as native dead letters. Replays only inspect status and never resend.
	if (result.failed || result.unknown) throw new Error("Email delivery failed or its outcome is unknown");
}

async function onJobError(job: DequeuedJobError<JobPayload>): Promise<void> {
	console.error(`[worker] job=${job.id} run=${job.runNumber} retriesLeft=${job.numRetriesLeft} ${job.error.name}`);
	if (job.data?.kind === "send-alert") return recordAlertJobError(job.data, job.numRetriesLeft);
	if (!job.data || job.data.kind !== "send-message") return;
	// An expired attempt can still be finishing its external request. Fencing queue finalization does
	// not fence SES. Conservatively unknown rather than allowing any second delivery.
	const changed = db.update(messages).set({ status: "unknown", error: "Worker attempt interrupted; reconcile SES feedback before resending", updatedAt: new Date() })
		.where(and(eq(messages._id, job.data.messageId), eq(messages.status, "sending"))).returning({ campaignId: messages.campaignId }).get();
	if (changed?.campaignId) db.update(campaigns).set({ status: "paused", updatedAt: new Date() })
		.where(and(eq(campaigns._id, changed.campaignId), eq(campaigns.status, "sending"))).run();
}

export function createQueueRunner({ isStopping = () => false }: { isStopping?: () => boolean } = {}): Runner<JobPayload> {
	return new Runner(getNativeQueue(), { run: async (job) => {
		// liteque may finish its semaphore wait after stop(). A last claimed job must not start SES.
		if (isStopping()) throw new RetryAfterError(1000);
		await runJob(job);
	}, onError: onJobError },
		{ concurrency: 1, pollIntervalMs: 250, timeoutSecs: 90, validator: jobSchema });
}
