"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function ButtonCampaignAction({ action, id, disabledReason, children }) {
	const [isPending, startTransition] = useTransition();

	function run() {
		startTransition(async () => {
			const result = await action(id);
			if (result?.error) toast.error(result.error);
		});
	}

	const button = (
		<Button variant="outline" onClick={run} disabled={isPending || Boolean(disabledReason)}>
			{children}
		</Button>
	);
	if (!disabledReason) return button;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span tabIndex={0} className="rounded-lg">
					{button}
				</span>
			</TooltipTrigger>
			<TooltipContent>{disabledReason}</TooltipContent>
		</Tooltip>
	);
}
