import { and, count, eq, inArray, sql } from "drizzle-orm";
import { SqliteQueue } from "liteque";
import { z } from "zod";
import { connectDb, db } from "@/db";
import { campaigns, messages } from "@/db/schema";
import { getQueueDatabase } from "./connection";

const QUEUE_NAME = "vibeletter";
const OBJECT_ID = /^[a-fA-F0-9]{24}$/;
export const jobSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("send-message"), messageId: z.string().regex(OBJECT_ID) }).strict(),
	z.object({ kind: z.literal("scheduled-campaign"), campaignId: z.string().regex(OBJECT_ID), scheduledAt: z.iso.datetime() }).strict(),
]);
export type JobPayload = z.infer<typeof jobSchema>;
export type JobStatus = "pending" | "pending_retry" | "running" | "failed";
type NativeRow = { id: number; queue: string; payload: string; createdAt: number; availableAt: number | null;
	status: JobStatus; expireAt: number | null; allocationId: string; numRunsLeft: number; maxNumRuns: number;
	idempotencyKey: string | null; priority: number };
export type OperatorJob = { id: string; kind: JobPayload["kind"]; status: JobStatus; payload: JobPayload;
	createdAt: Date; availableAt: Date | null; leaseExpiresAt: Date | null; attempts: number; maxAttempts: number;
	priority: number; messageStatus?: string; error?: string | null };

export class QueueOperationError extends Error {
	constructor(message: string, public readonly statusCode = 409) { super(message); this.name = "QueueOperationError"; }
}

export function getNativeQueue(): SqliteQueue<JobPayload> {
	return new SqliteQueue<JobPayload>(QUEUE_NAME, getQueueDatabase(), { defaultJobArgs: { numRetries: 2 }, keepFailedJobs: true });
}

function validJobId(id: string): number {
	if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new QueueOperationError("Invalid queue job ID", 400);
	return Number(id);
}

function nativeRow(id: string): NativeRow | undefined {
	return getQueueDatabase().$client.prepare("SELECT * FROM tasks WHERE queue = ? AND id = ?").get(QUEUE_NAME, validJobId(id)) as NativeRow | undefined;
}

function jobKey(payload: JobPayload): string {
	return payload.kind === "send-message" ? `message:${payload.messageId}` : `schedule:${payload.campaignId}:${payload.scheduledAt}`;
}

async function enqueue(payload: JobPayload, options: { delayMs?: number; priority?: number } = {}): Promise<string> {
	const parsed = jobSchema.parse(payload);
	const job = await getNativeQueue().enqueue(parsed, { idempotencyKey: jobKey(parsed), numRetries: 2,
		priority: options.priority ?? 0, delayMs: options.delayMs ?? 0 });
	if (job) return String(job.id);
	const existing = getQueueDatabase().$client.prepare("SELECT id FROM tasks WHERE queue = ? AND idempotencyKey = ?")
		.get(QUEUE_NAME, jobKey(parsed)) as { id: number } | undefined;
	if (!existing) throw new Error("Queue job disappeared while enqueueing; reconciliation will recover the app record");
	return String(existing.id);
}

export async function enqueueMessage(messageId: string): Promise<string> {
	if (!OBJECT_ID.test(messageId)) throw new QueueOperationError("Invalid message ID", 400);
	await connectDb();
	const message = db.select().from(messages).where(eq(messages._id, messageId)).get();
	if (!message) throw new QueueOperationError("Message not found", 404);
	if (message.status !== "queued") throw new QueueOperationError("Only queued messages can be enqueued");
	if (!message.retryDeadlineAt) db.update(messages).set({ retryDeadlineAt: new Date(Date.now() + 24 * 60 * 60_000) })
		.where(and(eq(messages._id, messageId), eq(messages.status, "queued"))).run();
	// Lower priority numbers run first. Signup/test emails do not sit behind a whole campaign.
	return enqueue({ kind: "send-message", messageId }, { priority: message.kind === "campaign" ? 0 : message.kind === "last-chance" ? 10 : -10 });
}

export async function enqueueMessages(ids: readonly string[]): Promise<number> {
	const unique = [...new Set(ids)];
	for (const id of unique) await enqueueMessage(id);
	return unique.length;
}

export async function enqueueScheduledCampaign(campaignId: string, scheduledAt: Date): Promise<string> {
	return enqueue({ kind: "scheduled-campaign", campaignId, scheduledAt: scheduledAt.toISOString() },
		{ delayMs: Math.max(0, scheduledAt.getTime() - Date.now()), priority: -20 });
}

async function operatorJob(row: NativeRow): Promise<OperatorJob> {
	const payload = jobSchema.parse(JSON.parse(row.payload));
	const value: OperatorJob = { id: String(row.id), kind: payload.kind, status: row.status, payload,
		createdAt: new Date(row.createdAt * 1000), availableAt: row.availableAt == null ? null : new Date(row.availableAt),
		leaseExpiresAt: row.expireAt == null ? null : new Date(row.expireAt * 1000),
		attempts: row.maxNumRuns - row.numRunsLeft, maxAttempts: row.maxNumRuns, priority: row.priority };
	if (payload.kind === "send-message") {
		await connectDb();
		const message = db.select({ status: messages.status, error: messages.error }).from(messages).where(eq(messages._id, payload.messageId)).get();
		if (message) { value.messageStatus = message.status; value.error = message.error; }
	}
	return value;
}

export async function getJob(id: string): Promise<OperatorJob | null> {
	const row = nativeRow(id);
	return row ? operatorJob(row) : null;
}

export async function listJobs({ limit = 50, offset = 0, status }: { limit?: number; offset?: number; status?: JobStatus | "dead-letter" } = {}) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new QueueOperationError("Invalid queue pagination", 400);
	const filter = status === "dead-letter" ? "failed" : status;
	if (filter && !["pending", "pending_retry", "running", "failed"].includes(filter)) throw new QueueOperationError("Invalid queue status", 400);
	const sqlite = getQueueDatabase().$client;
	const where = filter ? "queue = ? AND status = ?" : "queue = ?";
	const args = filter ? [QUEUE_NAME, filter] : [QUEUE_NAME];
	const rows = sqlite.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as NativeRow[];
	const total = (sqlite.prepare(`SELECT count(*) AS total FROM tasks WHERE ${where}`).get(...args) as { total: number }).total;
	return { items: await Promise.all(rows.map(operatorJob)), total, limit, offset };
}

export async function retryJob(id: string): Promise<OperatorJob> {
	const row = nativeRow(id);
	if (!row) throw new QueueOperationError("Queue job not found", 404);
	if (row.status !== "failed") throw new QueueOperationError("Only dead-letter jobs can be retried");
	const payload = jobSchema.parse(JSON.parse(row.payload));
	await connectDb();
	if (payload.kind === "send-message") {
		db.transaction((tx) => {
			const message = tx.select().from(messages).where(eq(messages._id, payload.messageId)).get();
			if (!message) throw new QueueOperationError("Message not found", 404);
			if (!["failed", "queued"].includes(message.status)) throw new QueueOperationError("Unknown, in-flight and already-sent messages cannot be retried. Reconcile SES feedback first.");
			// Keep accepted delivery identity intact so delayed SES feedback still reaches its original message.
			if (message.sesMessageId !== null || message.sentAt !== null) throw new QueueOperationError("SES already accepted this message. Duplicate the campaign or queue a new test instead of retrying this job.");
			if (message.campaignId && ["campaign", "last-chance"].includes(message.kind)) {
				const campaign = tx.select().from(campaigns).where(eq(campaigns._id, message.campaignId)).get();
				if (!campaign || !["sending", "sent"].includes(campaign.status)) throw new QueueOperationError("Resume the campaign before retrying its dead-letter job");
				if (campaign.status === "sent") tx.update(campaigns).set({ status: "sending", updatedAt: new Date() }).where(eq(campaigns._id, campaign._id)).run();
				if (message.status === "failed") tx.update(campaigns).set(message.kind === "last-chance"
					? { lastChance: sql`json_set(${campaigns.lastChance}, '$.failed', max(0, coalesce(json_extract(${campaigns.lastChance}, '$.failed'), 0) - 1))` }
					: { stats: sql`json_set(${campaigns.stats}, '$.failed', max(0, coalesce(json_extract(${campaigns.stats}, '$.failed'), 0) - 1))` })
					.where(eq(campaigns._id, message.campaignId)).run();
			}
			tx.update(messages).set({ status: "queued", error: null, deliveryAttempts: 0,
				retryDeadlineAt: new Date(Date.now() + 24 * 60 * 60_000), updatedAt: new Date() }).where(eq(messages._id, payload.messageId)).run();
		}, { behavior: "immediate" });
	} else {
		const campaign = db.select().from(campaigns).where(eq(campaigns._id, payload.campaignId)).get();
		if (campaign?.status !== "scheduled" || campaign.scheduledAt?.toISOString() !== payload.scheduledAt) throw new QueueOperationError("Campaign is no longer scheduled for this job");
	}
	// Native liteque has no per-job retry/cancel methods. Only retained FAILED rows are removed;
	// enqueue/finalize/leases/retries remain package-owned, and app state bridges a crash here.
	const removed = getQueueDatabase().$client.prepare("DELETE FROM tasks WHERE queue = ? AND id = ? AND status = 'failed'").run(QUEUE_NAME, Number(id));
	if (!removed.changes) throw new QueueOperationError("Queue job changed; refresh and retry");
	const newId = payload.kind === "send-message" ? await enqueueMessage(payload.messageId) : await enqueueScheduledCampaign(payload.campaignId, new Date(payload.scheduledAt));
	const saved = await getJob(newId);
	if (!saved) throw new Error("Retried job was not readable after enqueue");
	return saved;
}

export async function cancelJob(id: string): Promise<{ id: string; cancelled: true }> {
	const row = nativeRow(id);
	if (!row) throw new QueueOperationError("Queue job not found", 404);
	if (row.status === "running") throw new QueueOperationError("Running jobs cannot be cancelled; pause the campaign instead");
	const payload = jobSchema.parse(JSON.parse(row.payload));
	await connectDb();
	if (payload.kind === "send-message") {
		const message = db.select().from(messages).where(eq(messages._id, payload.messageId)).get();
		if (message && ["sending", "unknown"].includes(message.status)) throw new QueueOperationError("In-flight or uncertain delivery cannot be cancelled");
		db.update(messages).set({ status: "suppressed", error: "Cancelled by operator", updatedAt: new Date() })
			.where(and(eq(messages._id, payload.messageId), eq(messages.status, "queued"))).run();
		if (message?.campaignId && ["campaign", "last-chance"].includes(message.kind)) {
			// Import lazily because the shared sender also publishes jobs through this module.
			const { settleCampaign } = await import("@/lib/sending");
			await settleCampaign(message.campaignId);
		}
	} else {
		db.update(campaigns).set({ status: "draft", scheduledAt: null, updatedAt: new Date() }).where(and(
			eq(campaigns._id, payload.campaignId), eq(campaigns.status, "scheduled"), eq(campaigns.scheduledAt, new Date(payload.scheduledAt)),
		)).run();
	}
	const removed = getQueueDatabase().$client.prepare("DELETE FROM tasks WHERE queue = ? AND id = ? AND status != 'running'").run(QUEUE_NAME, Number(id));
	if (!removed.changes) throw new QueueOperationError("Job was claimed concurrently; app cancellation prevents a future send");
	if (nativeRow(id)) throw new Error("Cancelled job remained in the queue");
	return { id, cancelled: true };
}

export async function cancelScheduledCampaign(campaignId: string): Promise<number> {
	if (!OBJECT_ID.test(campaignId)) throw new QueueOperationError("Invalid campaign ID", 400);
	// Caller changes campaign status first. Stale running jobs are fenced by exact status/time checks.
	return getQueueDatabase().$client.prepare("DELETE FROM tasks WHERE queue = ? AND json_extract(payload, '$.kind') = 'scheduled-campaign' AND json_extract(payload, '$.campaignId') = ? AND status != 'running'")
		.run(QUEUE_NAME, campaignId).changes;
}

export async function queueStats() {
	await connectDb();
	const native = await getNativeQueue().stats();
	const delivery = db.select({ status: messages.status, count: count() }).from(messages).groupBy(messages.status).all();
	return { ...native, deadLetters: native.failed, delivery: Object.fromEntries(delivery.map(({ status, count: amount }) => [status, amount])),
		engine: "liteque", persistent: true, workerMode: "standalone-single-worker", leaseSeconds: 90, heartbeat: false };
}
