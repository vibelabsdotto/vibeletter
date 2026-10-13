import { and, count, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { isObjectIdString as isValidObjectId } from "@/lib/validation";
import { notFound } from "next/navigation";
import CampaignReport from "@/components/CampaignReport";
import FormCampaign from "@/components/FormCampaign";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { isSendingEnabled } from "@/lib/config";
import { db, connectDb } from "@/db";
import { campaigns, contacts, newsletters } from "@/db/schema";
import { serialize } from "@/lib/serialize";
import { listSesDomains } from "@/lib/ses";
import { getProviderBreakdown } from "@/lib/campaign-reports";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }) {
	const { id } = await params;
	if (!isValidObjectId(id)) notFound();

	await connectDb();
	const campaign = db.select().from(campaigns).where(eq(campaigns._id, id)).get();
	if (!campaign) notFound();
	const newsletter = db.select().from(newsletters).where(eq(newsletters._id, campaign.newsletterId)).get();
	if (!newsletter) notFound();

	if (!["draft", "scheduled"].includes(campaign.status)) {
		const [providers, remainingCount] = await Promise.all([
			getProviderBreakdown(campaign._id),
			countRemaining(campaign),
		]);
		return (
			<CampaignReport
				campaign={serialize(campaign)}
				newsletter={serialize(newsletter)}
				providers={providers}
				remainingCount={remainingCount}
			/>
		);
	}

	const [audienceCount, domains, sendTimes] = await Promise.all([
		db.select({ count: count() }).from(contacts).where(and(eq(contacts.newsletterId, newsletter._id), eq(contacts.status, "active"))).get().count,
		listSesDomains(),
		getSendTimes(campaign),
	]);
	const fromDomain = newsletter.fromEmail.split("@")[1];
	const isDomainVerified =
		Array.isArray(domains) && domains.some(({ domain, verified }) => domain === fromDomain && verified);

	return (
		<FormCampaign
			campaign={serialize(campaign)}
			newsletter={serialize(newsletter)}
			audienceCount={audienceCount}
			isDomainVerified={isDomainVerified}
			isSendingEnabled={isSendingEnabled()}
			testEmail={process.env.ADMIN_EMAIL}
			sendTimes={sendTimes}
			archiveUrlBase={newsletter.archiveEnabled ? getArchiveUrls(newsletter).absolutePost("") : null}
		/>
	);
}

// A newsletter's first issue borrows the times the other newsletters go out.
async function getSendTimes(campaign) {
	const at = sql`coalesce(${campaigns.scheduledAt}, ${campaigns.startedAt}, ${campaigns.sentAt})`.mapWith(campaigns.startedAt);
	function history(newsletterId) {
		return db.select({ status: campaigns.status, at }).from(campaigns).where(and(
			ne(campaigns._id, campaign._id), inArray(campaigns.status, ["scheduled", "sending", "paused", "sent"]),
			isNotNull(at), newsletterId ? eq(campaigns.newsletterId, newsletterId) : undefined,
		)).orderBy(desc(at)).limit(20).all();
	}
	const own = history(campaign.newsletterId);
	const rows = own.length > 0 ? own : history();
	return {
		history: rows.map(({ at }) => at.toISOString()),
		taken: own.filter(({ status }) => status === "scheduled").map(({ at }) => at.toISOString()),
	};
}

// Only a send capped to the most engaged has a next step. Close enough for the dialog: contacts who
// left after receiving it make this a little low, and the send itself skips everyone who has it.
async function countRemaining(campaign) {
	if (campaign.status !== "sent" || !campaign.audienceLimit) return 0;
	const active = db.select({ count: count() }).from(contacts).where(and(eq(contacts.newsletterId, campaign.newsletterId), eq(contacts.status, "active"))).get().count;
	const reached = (campaign.stats?.recipients ?? 0) + (campaign.lastChance?.recipients ?? 0);
	return Math.max(0, active - reached);
}
