import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { RetryAfterError } from "liteque";
import { connectDb, db } from "@/db";
import { alerts } from "@/db/schema";
import { getAlertAddresses } from "@/lib/alerts";
import { APP_NAME } from "@/lib/config";
import { reserveSendSlot } from "@/lib/rate-limit";
import { isDefiniteRejection } from "@/lib/sending";
import { sendSesEmail } from "@/lib/ses";
import type { AlertJob } from "@/queue";

export type AlertResult = "sent" | "skipped" | "unknown";

function escapeHtml(value: string) {
	return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatError(error: unknown): string {
	return String(error instanceof Error ? error.message : error).slice(0, 500);
}

function claimFence(job: Pick<AlertJob, "alertId" | "claimedAt">) {
	// A newer cooldown claim on the same key rewrites lastSentAt and supersedes this job.
	return and(eq(alerts._id, job.alertId), eq(alerts.lastSentAt, new Date(job.claimedAt)));
}

/** Worker-side executor. Only a queued claim may start SES; sending/unknown is never sent again. */
export async function processAlert(job: AlertJob): Promise<AlertResult> {
	await connectDb();
	const fence = claimFence(job);
	const alert = db.select({ status: alerts.status }).from(alerts).where(fence).get();
	if (!alert) return "skipped";
	if (alert.status === "sending") {
		// An earlier attempt claimed SES and never finished. It may have been accepted.
		db.update(alerts).set({ status: "unknown", error: "Worker attempt interrupted; alert not resent" })
			.where(and(fence, eq(alerts.status, "sending"))).run();
		console.error(`[alert] Delivery outcome unknown for ${job.alertId}; not resending`);
		return "unknown";
	}
	if (alert.status !== "queued") return "skipped";
	const addresses = getAlertAddresses();
	if (!addresses) {
		db.update(alerts).set({ status: "skipped", error: "ALERT_FROM, ADMIN_EMAIL or SENDING_ENABLED=true missing at send time" })
			.where(and(fence, eq(alerts.status, "queued"))).run();
		return "skipped";
	}
	// Same durable global slot as every other email. Waiting does not consume a queue retry.
	const delay = reserveSendSlot();
	if (delay > 0) throw new RetryAfterError(delay);
	const claimed = db.update(alerts).set({ status: "sending", error: null })
		.where(and(fence, eq(alerts.status, "queued"))).returning({ _id: alerts._id }).get();
	if (!claimed) return "skipped";
	let sesMessageId: string;
	try {
		({ sesMessageId } = await sendSesEmail({
			from: addresses.from, to: addresses.to, replyTo: undefined,
			subject: `[${APP_NAME}] ${job.title}`, text: job.text,
			html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(job.text)}</pre>`,
		}));
	} catch (error) {
		if (!isDefiniteRejection(error)) {
			db.update(alerts).set({ status: "unknown", error: formatError(error) }).where(and(fence, eq(alerts.status, "sending"))).run();
			console.error(`[alert] Delivery outcome unknown for ${job.alertId}; not resending:`, formatError(error));
			return "unknown";
		}
		// SES did not accept it. Release the claim for the queue's bounded retries.
		db.update(alerts).set({ status: "queued", error: formatError(error) }).where(and(fence, eq(alerts.status, "sending"))).run();
		throw error;
	}
	try {
		// A timed-out attempt may already be marked unknown. Its accepted ID still settles it.
		db.update(alerts).set({ status: "sent", sesMessageId, error: null })
			.where(and(fence, inArray(alerts.status, ["sending", "unknown"]))).run();
	} catch (error) {
		console.error(`[alert] SES accepted ${sesMessageId} but the record failed; not resending:`, formatError(error));
	}
	return "sent";
}

/** Queue error hook: final definite failures become failed, interrupted attempts unknown. */
export function recordAlertJobError(job: Pick<AlertJob, "alertId" | "claimedAt">, numRetriesLeft: number): void {
	const fence = claimFence(job);
	db.update(alerts).set({ status: "unknown", error: "Worker attempt interrupted; alert not resent" })
		.where(and(fence, eq(alerts.status, "sending"))).run();
	if (numRetriesLeft <= 0) db.update(alerts).set({ status: "failed" }).where(and(fence, eq(alerts.status, "queued"))).run();
}
