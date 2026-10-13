import { useState, useTransition } from "react";
import { previewCleanup } from "@/app/(app)/campaigns/actions";

// Counted each time a send dialog opens rather than with the page: it reads the whole list.
export function useCleanupPreview(campaignId) {
	const [preview, setPreview] = useState(null);
	const [isCounting, startCounting] = useTransition();

	function loadPreview() {
		startCounting(async () => setPreview(await previewCleanup(campaignId)));
	}

	return { preview, isCounting, loadPreview };
}
