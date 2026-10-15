import { createHash } from "node:crypto";
import { count, eq, lte } from "drizzle-orm";
import { connectDb, db } from "@/db";
import { rateLimitBuckets } from "@/db/schema";
import { LIMITS } from "./config";

export type RateLimitOptions = { name: string; limit: number; window: string; key: string };
const MAX_KEYS = 10_000;
const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const GLOBAL_SEND_KEY = "global-send-pacing";

function duration(value: string): number {
	const match = /^([1-9][0-9]*)\s*(ms|s|m|h|d)$/.exec(value.trim());
	const result = match ? Number(match[1]) * (UNITS[match[2]] ?? 0) : Number.NaN;
	if (!Number.isSafeInteger(result) || result < 1 || result > 366 * 86_400_000) throw new Error("Invalid rate-limit window");
	return result;
}

function keyFor(options: RateLimitOptions): string {
	if (!options.name || !options.key || options.key.length > 4096 || !Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error("Invalid rate-limit options");
	// Do not retain IP addresses, token identifiers or email addresses in the limiter table.
	return createHash("sha256").update(JSON.stringify([options.name, options.window, options.limit, options.key])).digest("hex");
}

function consume(options: RateLimitOptions, now: number): boolean {
	const key = keyFor(options);
	const window = duration(options.window);
	return db.transaction((tx) => {
		tx.delete(rateLimitBuckets).where(lte(rateLimitBuckets.expiresAt, new Date(now))).run();
		const row = tx.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.key, key)).get();
		if (row) {
			if (row.hits >= options.limit) return true;
			tx.update(rateLimitBuckets).set({ hits: row.hits + 1 }).where(eq(rateLimitBuckets.key, key)).run();
			return false;
		}
		const size = tx.select({ total: count() }).from(rateLimitBuckets).get()?.total ?? 0;
		if (size >= MAX_KEYS) return true;
		tx.insert(rateLimitBuckets).values({ key, hits: 1, expiresAt: new Date(now + window) }).run();
		return false;
	}, { behavior: "immediate" });
}

/** Shared durable fixed-window counting. Storage failures deny, never fall back to memory. */
export async function isRateLimited(options: RateLimitOptions): Promise<boolean> {
	try {
		await connectDb();
		return consume(options, Date.now());
	} catch (error) {
		console.error("[rate-limit] SQLite limiter unavailable; request denied:", error instanceof Error ? error.message : "storage error");
		return true;
	}
}

/** Historical export retained; now uses SQLite, not a process-local fallback. */
export function isLimitedInMemory(options: RateLimitOptions, now = Date.now()): boolean {
	return consume(options, now);
}

/** No reservation on a denied slot. Call again after the returned durable delay. */
export function reserveSendSlot(now = Date.now()): number {
	const interval = Math.ceil(1000 / LIMITS.sendRatePerSecond);
	return db.transaction((tx) => {
		const row = tx.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.key, GLOBAL_SEND_KEY)).get();
		const next = row?.expiresAt.getTime() ?? 0;
		if (next > now) return next - now;
		tx.insert(rateLimitBuckets).values({ key: GLOBAL_SEND_KEY, hits: 1, expiresAt: new Date(now + interval) })
			.onConflictDoUpdate({ target: rateLimitBuckets.key, set: { hits: 1, expiresAt: new Date(now + interval) } }).run();
		return 0;
	}, { behavior: "immediate" });
}

/**
 * "true": a trusted proxy strips client-supplied forwarding headers.
 * "cloudflare": Cloudflare sets CF-Connecting-IP. A request that bypasses Cloudflare can forge it.
 */
export function getClientIp(headers: Pick<Headers, "get">): string {
	const mode = process.env.TRUST_PROXY;
	let value: string | undefined;
	if (mode === "cloudflare") value = headers.get("cf-connecting-ip")?.trim();
	else if (mode === "true") value = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim();
	else return "unknown";
	return value && /^[0-9a-fA-F:.]+$/.test(value) && value.length <= 64 ? value : "unknown";
}
