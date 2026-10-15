import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, like, lt, or } from "drizzle-orm";
import { headers } from "next/headers";
import { connectDb, db } from "@/db";
import { alerts } from "@/db/schema";
import { formatActivity } from "@/lib/activity";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { getClientIp } from "@/lib/rate-limit";
import { ALERT_TEXT_MAX, ALERT_TITLE_MAX, enqueueAlert } from "@/queue";

const DEFAULT_COOLDOWN_MINUTES = 60;
const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60_000;

type Claim = { _id: string; lastSentAt: Date | null };

// Optional: requires a verified ALERT_FROM, and sends only while sending is enabled.
// The worker repeats this check right before SES I/O.
export function getAlertAddresses(): { from: string; to: string } | null {
	const { ALERT_FROM: from, ADMIN_EMAIL: to } = process.env;
	return from && to && isSendingEnabled() ? { from, to } : null;
}

// One conditional upsert claims the cooldown. A conflicting key is updated only after expiry;
// RETURNING distinguishes a successful claim from an in-cooldown no-op without a read/write race.
function claimAlert({ key, title, cooldownMinutes }: { key: string; title: string; cooldownMinutes: number }): Claim | undefined {
	const now = new Date();
	const cutoff = new Date(now.getTime() - cooldownMinutes * 60_000);
	const delivery = { title, lastSentAt: now, status: "queued" as const, sesMessageId: null, error: null, updatedAt: now };
	return db.insert(alerts)
		.values({ _id: randomBytes(12).toString("hex"), key, createdAt: now, ...delivery })
		.onConflictDoUpdate({
			target: alerts.key,
			set: delivery,
			setWhere: or(isNull(alerts.lastSentAt), lt(alerts.lastSentAt, cutoff)),
		})
		.returning({ _id: alerts._id, lastSentAt: alerts.lastSentAt }).get();
}

// Producers only write SQLite. The worker does the SES call with pacing and the no-blind-retry rule.
async function queueAlert(claim: Claim, title: string, text: string) {
	if (!claim.lastSentAt) throw new Error("Alert claim has no timestamp");
	const fence = and(eq(alerts._id, claim._id), eq(alerts.lastSentAt, claim.lastSentAt), eq(alerts.status, "queued"));
	try {
		await enqueueAlert({ alertId: claim._id, claimedAt: claim.lastSentAt.toISOString(),
			title: title.slice(0, ALERT_TITLE_MAX) || "Alert", text: text.slice(0, ALERT_TEXT_MAX) });
	} catch (error) {
		// No job exists. Release the cooldown so a later alert can try again.
		db.update(alerts).set({ status: "failed", error: `Enqueue failed: ${errorMessage(error)}`.slice(0, 500), lastSentAt: null }).where(fence).run();
		throw error;
	}
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

// Never throws: a failing alert must not break a send or webhook. Always logged;
// ADMIN_EMAIL gets at most one queued email per key and cooldown.
export async function sendAlert({ key, title, detail, path = "", cooldownMinutes = DEFAULT_COOLDOWN_MINUTES }: {
	key: string; title: string; detail: string; path?: string; cooldownMinutes?: number;
}) {
	console.warn(`[alert] ${title}: ${detail}`);
	try {
		if (!getAlertAddresses()) return;
		await connectDb();
		const claim = claimAlert({ key, title, cooldownMinutes });
		if (!claim) return;
		await queueAlert(claim, title, `${title}\n${detail}\n${getAppUrl()}${path}`);
	} catch (error) {
		console.error("[alert] Could not queue:", errorMessage(error));
	}
}

// Logins, new API keys and sends are logged and queued for email. The request never waits for SES.
export async function notifyActivity(lines: string[], { withUserAgent = false }: { withUserAgent?: boolean } = {}) {
	try {
		const list = await headers();
		const text = formatActivity(lines, {
			ip: getClientIp(list),
			country: list.get("x-vercel-ip-country"),
			userAgent: withUserAgent ? (list.get("user-agent") ?? "") : undefined,
		});
		console.info(`[activity] ${text.replaceAll("\n", " | ")}`);
		if (!getAlertAddresses()) return;
		await connectDb();
		const now = new Date();
		// Each notice needs its own delivery record. Settled records are kept for 30 days.
		db.delete(alerts).where(and(like(alerts.key, "activity:%"), lt(alerts.lastSentAt, new Date(now.getTime() - ACTIVITY_RETENTION_MS)),
			inArray(alerts.status, ["sent", "failed", "skipped", "unknown"]))).run();
		const title = lines[0] || "Activity";
		const claim = db.insert(alerts).values({ _id: randomBytes(12).toString("hex"), key: `activity:${randomBytes(12).toString("hex")}`,
			title, lastSentAt: now, status: "queued", createdAt: now, updatedAt: now }).returning({ _id: alerts._id, lastSentAt: alerts.lastSentAt }).get();
		await queueAlert(claim, title, text);
	} catch (error) {
		console.error("[alert] Activity notice failed:", errorMessage(error));
	}
}
