import { Skeleton } from "@/components/ui/skeleton";

export default function SkeletonDomains() {
	return (
		<div className="flex flex-col gap-3">
			{[0, 1].map((key) => (
				<Skeleton key={key} className="h-[118px] rounded-xl" />
			))}
		</div>
	);
}
