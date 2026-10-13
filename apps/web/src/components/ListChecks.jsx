import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { cn } from "@/lib/utils";

export default function ListChecks({ checks }) {
	return (
		<ul className="grid gap-x-6 gap-y-2.5 rounded-xl bg-card p-4 shadow-border sm:grid-cols-2">
			{checks.map(({ id, label, isOk, isWarning, detail }) => {
				const Icon = isOk ? CircleCheck : isWarning ? CircleAlert : CircleX;
				return (
					<li key={id} className="flex min-w-0 items-center gap-2 text-sm">
						<Icon
							className={cn(
								"size-4 shrink-0",
								isOk ? "text-emerald-500" : isWarning ? "text-amber-500" : "text-red-500"
							)}
						/>
						<span className={cn("truncate", isOk && "text-muted-foreground")}>{label}</span>
						{detail && (
							<span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
								{detail}
							</span>
						)}
					</li>
				);
			})}
		</ul>
	);
}
