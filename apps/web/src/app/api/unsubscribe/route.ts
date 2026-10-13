import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, connectDb } from "@/db";
import { campaigns as campaignTable, contacts, messages } from "@/db/schema";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";

const NO_STORE = { "Cache-Control": "no-store" };
// Bounced and complained contacts stay as they are: those statuses also block sending.
const SUBSCRIBED_STATUSES = ["active", "dormant", "pending"] as const;
type SubscriptionReference = { contactId: string; newsletterId: string };
const RECENT_CAMPAIGNS = 5;
// Gmail and Yahoo send one-click requests from shared mail servers, so keep this generous.
const RATE_LIMIT = { name: "unsubscribe", limit: 60, window: "1 m" };

// Links don't carry the campaign, so the unsubscribe counts for the latest campaign sent to them.
function creditLatestCampaign({ contactId, newsletterId }: SubscriptionReference) {
	const campaigns = db.select({ _id: campaignTable._id }).from(campaignTable)
		.where(and(eq(campaignTable.newsletterId, newsletterId), isNotNull(campaignTable.startedAt)))
		.orderBy(desc(campaignTable.startedAt)).limit(RECENT_CAMPAIGNS).all();
	for (const { _id } of campaigns) {
		const wasSent = db.select({ _id: messages._id }).from(messages).where(and(
			eq(messages.kind, "campaign"), eq(messages.campaignId, _id),
			eq(messages.contactId, contactId), isNotNull(messages.sentAt),
		)).get();
		if (!wasSent) continue;
		// Increment one JSON counter in SQL, never overwrite other delivery/open updates.
		db.update(campaignTable).set({
			stats: sql`json_set(coalesce(${campaignTable.stats}, '{}'), '$.unsubscribed', coalesce(json_extract(${campaignTable.stats}, '$.unsubscribed'), 0) + 1)`,
			updatedAt: new Date(),
		}).where(eq(campaignTable._id, _id)).run();
		return;
	}
}

async function unsubscribe({ contactId, newsletterId }: SubscriptionReference) {
	await connectDb();
	const now = new Date();
	const changed = db.update(contacts).set({ status: "unsubscribed", unsubscribedAt: now, confirmationNonce: null, updatedAt: now })
		.where(and(eq(contacts._id, contactId), eq(contacts.newsletterId, newsletterId), inArray(contacts.status, SUBSCRIBED_STATUSES)))
		.returning({ _id: contacts._id }).get();
	if (!changed) return;
	console.log(`[unsubscribe] Contact ${contactId} unsubscribed from newsletter ${newsletterId}`);
	try {
		creditLatestCampaign({ contactId, newsletterId });
	} catch (error) {
		console.error("[unsubscribe] Could not credit the campaign:", error instanceof Error ? error.message : error);
	}
}

function redirectToPage(request: Request, params: Record<string, string | null>) {
	const url = new URL("/unsubscribe", request.url);
	for (const [key, value] of Object.entries(params)) {
		if (value) url.searchParams.set(key, value);
	}
	const response = NextResponse.redirect(url, 303);
	response.headers.set("Cache-Control", "no-store");
	return response;
}

// Some mail apps open the List-Unsubscribe URL in a browser: never change anything on GET.
export function GET(request: Request) {
	return redirectToPage(request, { token: new URL(request.url).searchParams.get("token") });
}

// RFC 8058 one-click endpoint. The confirmation page form posts here too, with source=page.
export async function POST(request: Request) {
	const token = new URL(request.url).searchParams.get("token");
	const form = await request.formData().catch(() => null);
	const isPageForm = form?.get("source") === "page";

	function respond(status: number, pageStatus: "invalid" | "error" | "done") {
		if (!isPageForm) return new NextResponse(null, { status, headers: NO_STORE });
		return redirectToPage(request, {
			token: pageStatus === "invalid" ? null : token,
			status: pageStatus,
		});
	}

	if (await isRateLimited({ ...RATE_LIMIT, key: getClientIp(request.headers) })) return respond(429, "error");

	const reference = verifyUnsubscribeToken(token);
	if (!reference) return respond(400, "invalid");

	try {
		await unsubscribe(reference);
		return respond(200, "done");
	} catch (error) {
		console.error("[unsubscribe] Failed:", error);
		return respond(500, "error");
	}
}
