import HeaderPage from "@/components/HeaderPage";
import SkeletonCampaigns from "@/components/SkeletonCampaigns";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
	return (
		<>
			<HeaderPage title="Campaigns">
				<Skeleton className="h-9 w-32 rounded-lg" />
			</HeaderPage>
			<SkeletonCampaigns rows={10} hasActions />
		</>
	);
}
