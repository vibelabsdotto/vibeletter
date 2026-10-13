import "server-only";
import { randomBytes } from "node:crypto";
import { isNull, lt, or } from "drizzle-orm";
import { headers } from "next/headers";
import { after } from "next/server";
import { connectDb, db } from "@/db";
import { alerts } from "@/db/schema";
import { formatActivity } from "@/lib/activity";
import { APP_NAME, getAppUrl, isSendingEnabled } from "@/lib/config";
import { getClientIp, reserveSendSlot } from "@/lib/rate-limit";
import { sendSesEmail } from "@/lib/ses";

const DEFAULT_COOLDOWN_MINUTES = 60;
const MAX_PACING_WAIT_MS = 5_000;

function escapeHtml(value: string) {
	return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Optional: requires a verified ALERT_FROM, and sends only while sending is enabled.
async function sendEmail({ title, text }: { title: string; text: string }) {
	const { ALERT_FROM: from, ADMIN_EMAIL: to } = process.env;
	if (!from || !to || !isSendingEnabled()) return;
	// Optional notices share the worker's durable pacing, but never retry transport.
	const deadline = Date.now() + MAX_PACING_WAIT_MS;
	for (;;) {
		const delay = reserveSendSlot();
		if (delay === 0) break;
		if (Date.now() + delay > deadline) throw new Error("SES pacing slot unavailable for optional notice");
		await new Promise<void>((resolve) => setTimeout(resolve, delay));
	}
	await sendSesEmail({
		from,
		to,
		replyTo: undefined,
		subject: `[${APP_NAME}] ${title}`,
		text,
		html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
	});
}

// One conditional upsert claims the cooldown. A conflicting key is updated only after expiry;
// RETURNING distinguishes a successful claim from an in-cooldown no-op without a read/write race.
async function claimAlert({ key, title, cooldownMinutes }: { key: string; title: string; cooldownMinutes: number }) {
	const now = new Date();
	const cutoff = new Date(now.getTime() - cooldownMinutes * 60_000);
	return Boolean(db.insert(alerts)
		.values({ _id: randomBytes(12).toString("hex"), key, title, lastSentAt: now, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: alerts.key,
			set: { title, lastSentAt: now, updatedAt: now },
			setWhere: or(isNull(alerts.lastSentAt), lt(alerts.lastSentAt, cutoff)),
		})
		.returning({ _id: alerts._id }).get());
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

// Never throws: a failing alert must not break a send or webhook. Always logged;
// ADMIN_EMAIL receives at most one email per cooldown.
export async function sendAlert({ key, title, detail, path = "", cooldownMinutes = DEFAULT_COOLDOWN_MINUTES }: {
	key: string; title: string; detail: string; path?: string; cooldownMinutes?: number;
}) {
	console.warn(`[alert] ${title}: ${detail}`);
	try {
		await connectDb();
		if (!(await claimAlert({ key, title, cooldownMinutes }))) return;
		await sendEmail({ title, text: `${title}\n${detail}\n${getAppUrl()}${path}` });
	} catch (error) {
		console.error("[alert] Could not send:", errorMessage(error));
	}
}

// Logins, new API keys and sends are logged and emailed after the response, without blocking it.
export async function notifyActivity(lines: string[], { withUserAgent = false }: { withUserAgent?: boolean } = {}) {
	try {
		const list = await headers();
		const text = formatActivity(lines, {
			ip: getClientIp(list),
			country: list.get("x-vercel-ip-country"),
			userAgent: withUserAgent ? (list.get("user-agent") ?? "") : undefined,
		});
		after(async () => {
			console.info(`[activity] ${text.replaceAll("\n", " | ")}`);
			try {
				await sendEmail({ title: lines[0], text });
			} catch (error) {
				console.error("[alert] Activity notice failed:", errorMessage(error));
			}
		});
	} catch (error) {
		console.error("[alert] Activity notice failed:", errorMessage(error));
	}
}
