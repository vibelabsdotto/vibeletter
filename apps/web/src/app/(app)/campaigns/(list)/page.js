import { Send } from "lucide-react";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import TableCampaigns from "@/components/TableCampaigns";
import { getIssuePageUrl } from "@/lib/archive-data";
import { asc } from "drizzle-orm";
import { db, connectDb } from "@/db";
import { newsletters as newsletterTable } from "@/db/schema";
import { toNewsletterMap, toNewsletterOptions } from "@/lib/newsletters";
import { listRecentCampaigns, newsletterSummaryColumns } from "@/lib/ui-data";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
	await connectDb();
	const [campaigns, newsletters] = await Promise.all([
		listRecentCampaigns(200),
		db.select({ ...newsletterSummaryColumns, archiveEnabled: newsletterTable.archiveEnabled })
			.from(newsletterTable).orderBy(asc(newsletterTable.createdAt)).all(),
	]);
	const newslettersById = new Map(newsletters.map((newsletter) => [newsletter._id.toString(), newsletter]));
	const pageUrls = Object.fromEntries(
		campaigns
			.map((campaign) => [
				campaign._id.toString(),
				getIssuePageUrl({ campaign, newsletter: newslettersById.get(campaign.newsletterId.toString()) }),
			])
			.filter(([, url]) => url)
	);

	return (
		<>
			<HeaderPage title="Campaigns">
				<ButtonNewCampaign newsletters={toNewsletterOptions(newsletters)} />
			</HeaderPage>

			{campaigns.length === 0 ? (
				<StateEmpty icon={Send} title="No campaigns yet" />
			) : (
				<div className="animate-enter">
					<TableCampaigns
						campaigns={campaigns}
						newsletters={toNewsletterMap(newsletters)}
						hasActions
						pageUrls={pageUrls}
					/>
				</div>
			)}
		</>
	);
}
