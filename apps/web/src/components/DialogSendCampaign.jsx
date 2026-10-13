"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { sendCampaign } from "@/app/(app)/campaigns/actions";
import InputAudienceLimit, { countRecipients } from "@/components/InputAudienceLimit";
import ListCleanupPreview from "@/components/ListCleanupPreview";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { summarizePreview } from "@/lib/cleanup";
import { formatCount, formatSendTime } from "@/lib/format";
import { useCleanupPreview } from "@/lib/use-cleanup-preview";

export default function DialogSendCampaign({
	campaignId,
	audienceCount,
	scheduledAt,
	isCleanupEnabled,
	blockingMessage,
	onBeforeSend,
}) {
	const router = useRouter();
	const [isOpen, setIsOpen] = useState(false);
	const [limit, setLimit] = useState("");
	const [isSending, startSending] = useTransition();
	const { preview, isCounting, loadPreview } = useCleanupPreview(campaignId);
	// With the list cleanup on, cold contacts get the last-chance email instead and don't count.
	const summary = preview?.enabled ? summarizePreview(preview, Number.parseInt(limit, 10)) : null;
	const issueAudience = preview?.enabled ? preview.issue : audienceCount;
	const recipients = summary ? summary.issue : countRecipients(limit, audienceCount);

	function changeOpen(nextIsOpen) {
		if (nextIsOpen && isCleanupEnabled) loadPreview();
		setIsOpen(nextIsOpen);
	}

	function send() {
		startSending(async () => {
			if (!(await onBeforeSend())) return;
			const result = await sendCampaign(campaignId, { audienceLimit: Number.parseInt(limit, 10) || undefined });
			if (result?.error) return toast.error(result.error);
			setIsOpen(false);
			toast.success("Sending started");
			router.refresh();
		});
	}

	if (blockingMessage) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span tabIndex={0} className="rounded-lg">
						<Button disabled>
							<Send data-icon="inline-start" />
							Send
						</Button>
					</span>
				</TooltipTrigger>
				<TooltipContent>{blockingMessage}</TooltipContent>
			</Tooltip>
		);
	}

	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button>
					<Send data-icon="inline-start" />
					Send
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="tabular-nums">Send to {formatCount(recipients, "contact")}?</DialogTitle>
					<DialogDescription>
						{scheduledAt
							? `It goes out now instead of ${formatSendTime(scheduledAt)}.`
							: "Most engaged contacts receive it first."}
						{recipients < issueAudience && " Send it to more later from its page."}
					</DialogDescription>
				</DialogHeader>
				<InputAudienceLimit value={limit} onChange={setLimit} audienceCount={issueAudience} />
				{isCleanupEnabled && <ListCleanupPreview summary={summary} isCounting={isCounting} error={preview?.error} />}
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button onClick={send} disabled={isSending || recipients + (summary?.lastChance ?? 0) === 0} className="min-w-20">
						{isSending ? <Loader2 className="animate-spin" /> : "Send"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
