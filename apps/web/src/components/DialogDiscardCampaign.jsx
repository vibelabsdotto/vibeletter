"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { discardCampaign } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { formatSendTime } from "@/lib/format";

// Opened from a menu, so the caller owns the open state.
export default function DialogDiscardCampaign({ id, subject, scheduledAt, isOpen, onOpenChange, redirectTo }) {
	const router = useRouter();
	const [isDiscarding, startDiscarding] = useTransition();
	const isScheduled = Boolean(scheduledAt);

	function discard() {
		startDiscarding(async () => {
			const result = await discardCampaign(id);
			if (result?.error) return void toast.error(result.error);
			onOpenChange(false);
			toast.success(isScheduled ? "Campaign discarded, it won't go out" : "Draft discarded");
			if (redirectTo) router.replace(redirectTo);
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>{isScheduled ? "Discard this scheduled campaign?" : "Discard this draft?"}</DialogTitle>
					<DialogDescription>
						<span className="font-medium text-foreground">{subject || "Untitled"}</span>{" "}
						{isScheduled
							? `won't go out on ${formatSendTime(scheduledAt)} and leaves your campaigns.`
							: "leaves your campaigns. Nothing is sent."}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button variant="destructive" onClick={discard} disabled={isDiscarding} className="min-w-20">
						{isDiscarding ? <Loader2 className="animate-spin" /> : "Discard"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
