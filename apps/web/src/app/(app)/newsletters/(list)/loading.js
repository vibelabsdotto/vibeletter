import HeaderPage from "@/components/HeaderPage";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
	return (
		<>
			<HeaderPage title="Newsletters">
				<Skeleton className="h-9 w-20 rounded-lg" />
			</HeaderPage>
			<div aria-hidden="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{[0, 1].map((index) => (
					<div key={index} className="flex flex-col gap-6 rounded-xl bg-card p-4 shadow-border">
						<div className="flex items-center gap-3">
							<Skeleton className="size-11 shrink-0 rounded-full" />
							<div className="flex flex-1 flex-col gap-2">
								<Skeleton className="h-3.5 w-28" />
								<Skeleton className="h-3 w-40" />
							</div>
						</div>
						<div className="flex items-end justify-between gap-3">
							<div className="flex flex-col gap-2">
								<Skeleton className="h-6 w-20" />
								<Skeleton className="h-2.5 w-24" />
							</div>
							<div className="flex gap-1.5">
								<Skeleton className="h-6 w-20 rounded-full" />
								<Skeleton className="h-6 w-16 rounded-full" />
							</div>
						</div>
					</div>
				))}
			</div>
		</>
	);
}
