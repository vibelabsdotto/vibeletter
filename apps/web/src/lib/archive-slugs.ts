import "server-only";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { connectDb, db } from "@/db";
import { campaigns, newsletters } from "@/db/schema";
import { slugify } from "@/lib/slug";

type Reader = Pick<typeof db, "select">;

function availableArchiveSlug(reader: Reader, base: string) {
	const candidates = Array.from({ length: 99 }, (_, index) => index === 0 ? base : `${base}-${index + 1}`);
	const used = new Set(reader.select({ slug: campaigns.archiveSlug }).from(campaigns)
		.where(inArray(campaigns.archiveSlug, candidates)).all().map(({ slug }) => slug));
	const available = candidates.find((slug) => !used.has(slug));
	if (available !== undefined) return available;
	let suffix = Date.now();
	while (reader.select({ _id: campaigns._id }).from(campaigns)
		.where(eq(campaigns.archiveSlug, `${base}-${suffix}`)).get()) suffix += 1;
	return `${base}-${suffix}`;
}

export async function uniqueArchiveSlug(base: string) {
	await connectDb();
	return availableArchiveSlug(db, base);
}

// Reserve inside an immediate SQLite transaction so concurrent sends cannot choose the same slug.
// A stale send must not overwrite an archive slug already assigned by another action.
export async function assignArchiveSlug({ campaign, newsletter }: {
	campaign: Pick<typeof campaigns.$inferSelect, "_id" | "archiveSlug" | "subject">;
	newsletter: Pick<typeof newsletters.$inferSelect, "archiveEnabled">;
}) {
	if (!newsletter.archiveEnabled || campaign.archiveSlug) return;
	await connectDb();
	db.transaction((tx) => {
		const current = tx.select({ slug: campaigns.archiveSlug }).from(campaigns)
			.where(eq(campaigns._id, campaign._id)).get();
		if (!current || current.slug) return;
		tx.update(campaigns)
			.set({ archiveSlug: availableArchiveSlug(tx, slugify(campaign.subject, 80) || "issue"), updatedAt: new Date() })
			.where(and(eq(campaigns._id, campaign._id), or(isNull(campaigns.archiveSlug), eq(campaigns.archiveSlug, ""))))
			.returning({ archiveSlug: campaigns.archiveSlug }).get();
	}, { behavior: "immediate" });
}
