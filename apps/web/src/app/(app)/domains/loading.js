import HeaderPage from "@/components/HeaderPage";
import SkeletonDomains from "@/components/SkeletonDomains";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
	return (
		<>
			<HeaderPage title="Domains">
				<Skeleton className="h-9 w-32 rounded-lg" />
				<Skeleton className="h-9 w-20 rounded-lg" />
			</HeaderPage>
			<SkeletonDomains />
		</>
	);
}
