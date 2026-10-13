import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, newsletters } from "@/db/schema";

export const newsletterSummaryColumns = {
	_id: newsletters._id,
	name: newsletters.name,
	slug: newsletters.slug,
	imageUrl: newsletters.imageUrl,
	fromEmail: newsletters.fromEmail,
};

// Keep large HTML/Markdown bodies out of dashboard list queries.
export function listRecentCampaigns(limit: number, newsletterId?: string) {
	const activityAt = sql<Date>`coalesce(${campaigns.sentAt}, ${campaigns.startedAt}, ${campaigns.scheduledAt}, ${campaigns.updatedAt})`
		.mapWith(campaigns.updatedAt);
	return db.select({
		_id: campaigns._id,
		newsletterId: campaigns.newsletterId,
		subject: campaigns.subject,
		status: campaigns.status,
		stats: campaigns.stats,
		thumbnailUrl: campaigns.thumbnailUrl,
		archiveSlug: campaigns.archiveSlug,
		scheduledAt: campaigns.scheduledAt,
		startedAt: campaigns.startedAt,
		sentAt: campaigns.sentAt,
		updatedAt: campaigns.updatedAt,
		activityAt,
	}).from(campaigns)
		.where(and(ne(campaigns.status, "canceled"), newsletterId ? eq(campaigns.newsletterId, newsletterId) : undefined))
		.orderBy(desc(activityAt), desc(campaigns._id))
		.limit(limit).all();
}
