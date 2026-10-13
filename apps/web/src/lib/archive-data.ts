import "server-only";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cache } from "react";
import { connectDb, db } from "@/db";
import { campaigns, contacts, newsletters } from "@/db/schema";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
type Campaign = typeof campaigns.$inferSelect;
export const PUBLISHED_STATUSES: Campaign["status"][] = ["sending", "paused", "sent"];

function listedFilter() {
	return and(
		isNotNull(campaigns.archiveSlug),
		or(eq(campaigns.archiveListed, true), isNull(campaigns.archiveListed)),
		inArray(campaigns.status, PUBLISHED_STATUSES),
	);
}

const cardFields = {
	_id: campaigns._id,
	subject: campaigns.subject,
	previewText: campaigns.previewText,
	archiveSlug: campaigns.archiveSlug,
	archivePinned: campaigns.archivePinned,
	sentAt: campaigns.sentAt,
	startedAt: campaigns.startedAt,
	thumbnailUrl: campaigns.thumbnailUrl,
	webViews: campaigns.webViews,
};

export const getArchiveNewsletter = cache(async (slug: string) => {
	if (!SLUG_PATTERN.test(slug)) return null;
	await connectDb();
	return db
		.select({
			_id: newsletters._id,
			name: newsletters.name,
			slug: newsletters.slug,
			imageUrl: newsletters.imageUrl,
			fromName: newsletters.fromName,
			description: newsletters.description,
			socialLinks: newsletters.socialLinks,
			author: newsletters.author,
		})
		.from(newsletters)
		.where(and(eq(newsletters.slug, slug), eq(newsletters.archiveEnabled, true)))
		.get() ?? null;
});

// Shared images are newsletter banners, not issue-specific thumbnails. Unlisted issues do not count.
const getSharedThumbnails = cache(async (newsletterId: string) => {
	await connectDb();
	const rows = db
		.select({ thumbnailUrl: campaigns.thumbnailUrl })
		.from(campaigns)
		.where(and(eq(campaigns.newsletterId, newsletterId), isNotNull(campaigns.thumbnailUrl), listedFilter()))
		.groupBy(campaigns.thumbnailUrl)
		.having(gt(count(), 1))
		.all();
	return new Set(rows.map(({ thumbnailUrl }) => thumbnailUrl));
});

async function withOwnThumbnails<T extends { thumbnailUrl: string | null }>(newsletterId: string, issues: T[]) {
	const shared = await getSharedThumbnails(newsletterId);
	return issues.map((issue) => shared.has(issue.thumbnailUrl) ? { ...issue, thumbnailUrl: undefined } : issue);
}

export const getArchiveIssue = cache(async (newsletterId: string, postSlug: string) => {
	if (!ARCHIVE_SLUG_PATTERN.test(postSlug)) return null;
	await connectDb();
	const issue = db
		.select({ ...cardFields, format: campaigns.format, markdown: campaigns.markdown, html: campaigns.html, source: campaigns.source })
		.from(campaigns)
		.where(and(eq(campaigns.newsletterId, newsletterId), eq(campaigns.archiveSlug, postSlug), inArray(campaigns.status, PUBLISHED_STATUSES)))
		.get();
	return issue ? (await withOwnThumbnails(newsletterId, [issue]))[0] : null;
});

export async function listArchiveIssues(newsletterId: string, { limit = 0, excludeId }: { limit?: number; excludeId?: string } = {}) {
	await connectDb();
	const query = db
		.select(cardFields)
		.from(campaigns)
		.where(and(eq(campaigns.newsletterId, newsletterId), listedFilter(), excludeId ? ne(campaigns._id, excludeId) : undefined))
		.orderBy(desc(campaigns.sentAt), desc(campaigns.startedAt));
	// Mongoose's zero limit meant unlimited; SQLite's LIMIT 0 means no rows.
	const issues = limit ? query.limit(Math.abs(Math.trunc(limit))).all() : query.all();
	return withOwnThumbnails(newsletterId, issues);
}

// For the API: every listed issue that went out.
export async function listPublishedIssues(newsletterId: string) {
	await connectDb();
	return db
		.select({
			_id: campaigns._id,
			subject: campaigns.subject,
			previewText: campaigns.previewText,
			archiveSlug: campaigns.archiveSlug,
			sentAt: campaigns.sentAt,
			startedAt: campaigns.startedAt,
		})
		.from(campaigns)
		.where(and(eq(campaigns.newsletterId, newsletterId), listedFilter()))
		.orderBy(desc(campaigns.sentAt), desc(campaigns.startedAt))
		.all();
}

// Cached per render: popup and subscribe blocks show the same count.
export const countReaders = cache(async (newsletterId: string) => {
	await connectDb();
	return db.select({ count: count() }).from(contacts)
		.where(and(eq(contacts.newsletterId, newsletterId), eq(contacts.status, "active"))).get()?.count ?? 0;
});

export function revalidateArchive() {
	revalidatePath("/archive/[slug]", "layout");
}

// Unlisted issues retain their page; only archive enablement, slug and send status decide.
export function getIssuePageUrl({ campaign, newsletter }: {
	campaign: Pick<Campaign, "archiveSlug" | "status">;
	newsletter?: Pick<typeof newsletters.$inferSelect, "archiveEnabled" | "slug"> | null;
}) {
	if (!newsletter?.archiveEnabled || !campaign.archiveSlug || !PUBLISHED_STATUSES.includes(campaign.status)) return null;
	return getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug);
}
