import { and, eq } from "drizzle-orm";
import { db, connectDb } from "@/db";
import { campaigns, newsletters } from "@/db/schema";
import { getArchiveUrls } from "@/lib/archive-hosts";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

// On the app domain a post slug resolves to the correct newsletter archive.
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
	const { slug } = await params;
	if (!SLUG_PATTERN.test(slug)) return new Response("Not found", { status: 404 });
	await connectDb();
	const newsletter = db.select({ slug: newsletters.slug }).from(campaigns)
		.innerJoin(newsletters, eq(newsletters._id, campaigns.newsletterId))
		.where(and(eq(campaigns.archiveSlug, slug), eq(newsletters.archiveEnabled, true))).get();
	if (!newsletter) return new Response("Not found", { status: 404 });
	return Response.redirect(new URL(getArchiveUrls(newsletter).post(slug), request.url), 307);
}
