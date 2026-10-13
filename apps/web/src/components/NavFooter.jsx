import { LogOut } from "lucide-react";
import { logout } from "@/app/(app)/actions";
import ButtonThemeToggle from "@/components/ButtonThemeToggle";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { APP_NAME, COMPANY_NAME, COMPANY_URL, REPOSITORY_URL } from "@/lib/brand";
import { isSendingEnabled } from "@/lib/config";
import { cn } from "@/lib/utils";

export default function NavFooter() {
	const isOn = isSendingEnabled();

	return (
		<div className="flex flex-col gap-3 pt-4">
			<div className="flex items-center justify-between gap-2">
				<Tooltip>
					<TooltipTrigger asChild>
						<span
							tabIndex={0}
							className="inline-flex h-7 items-center gap-2 rounded-full pr-3 pl-2.5 text-xs font-medium text-muted-foreground shadow-border outline-none"
						>
							<span
								className={cn("size-1.5 rounded-full", isOn ? "bg-emerald-500" : "bg-muted-foreground/50")}
							/>
							{isOn ? "Sending on" : "Sending off"}
						</span>
					</TooltipTrigger>
					<TooltipContent side="top">
						{isOn ? "SENDING_ENABLED is true" : "Set SENDING_ENABLED=true to send"}
					</TooltipContent>
				</Tooltip>
				<div className="flex items-center">
					<ButtonThemeToggle />
					<form action={logout}>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button type="submit" variant="ghost" size="icon" aria-label="Log out">
									<LogOut />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Log out</TooltipContent>
						</Tooltip>
					</form>
				</div>
			</div>
			<nav
				aria-label={`${APP_NAME} links`}
				className="flex items-center justify-between gap-3 px-2.5 text-xs text-muted-foreground"
			>
				<a
					href={COMPANY_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4"
				>
					by {COMPANY_NAME}
				</a>
				<a
					href={REPOSITORY_URL}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={`${APP_NAME} on GitHub`}
					className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4"
				>
					GitHub
				</a>
			</nav>
		</div>
	);
}
