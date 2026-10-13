import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, connectDb } from "@/db";
import { campaigns } from "@/db/schema";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { isObjectIdString } from "@/lib/validation";

const BOT_PATTERN = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|axios|go-http/i;
const RATE_LIMIT = { name: "views", limit: 30, window: "10 m" };

function noContent() {
	return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// One beacon per issue per browser/day. Bots, malformed requests and rate-limited clients do not count.
export async function POST(request: Request) {
	const userAgent = request.headers.get("user-agent") ?? "";
	const input: unknown = await request.json().catch(() => null);
	const id = input && typeof input === "object" && "id" in input ? input.id : null;
	if (typeof id !== "string" || !isObjectIdString(id) || !userAgent || BOT_PATTERN.test(userAgent)) return noContent();
	if (await isRateLimited({ ...RATE_LIMIT, key: getClientIp(request.headers) })) return noContent();
	await connectDb();
	db.update(campaigns).set({ webViews: sql`${campaigns.webViews} + 1`, updatedAt: new Date() })
		.where(and(eq(campaigns._id, id), isNotNull(campaigns.archiveSlug), inArray(campaigns.status, ["sending", "paused", "sent"])))
		.run();
	return noContent();
}
