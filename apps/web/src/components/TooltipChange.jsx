"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// The trigger element is created here: Radix can't slot an element rendered by a Server Component.
export default function TooltipChange({ label, children }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="cursor-default">{children}</span>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
