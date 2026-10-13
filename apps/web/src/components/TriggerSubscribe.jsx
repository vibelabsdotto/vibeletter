"use client";

import { useEffect } from "react";
import { useSubscribe } from "@/components/ProviderSubscribe";
import { readStoredNumber, subscribeSnoozedKey, subscribedKey } from "@/lib/storage";

// Opens once the reader is into the issue, not on arrival, and stays away for two weeks once closed.
const SCROLL_DEPTH = 0.45;
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

export default function TriggerSubscribe({ newsletterSlug }) {
	const { open } = useSubscribe();

	useEffect(() => {
		const isSubscribed = () => readStoredNumber(subscribedKey(newsletterSlug)) > 0;
		const isSnoozed = () => Date.now() - readStoredNumber(subscribeSnoozedKey(newsletterSlug)) < SNOOZE_MS;
		if (isSubscribed() || isSnoozed()) return;

		function onScroll() {
			const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
			if ((scrollTop + clientHeight) / scrollHeight < SCROLL_DEPTH) return;
			window.removeEventListener("scroll", onScroll);
			if (!isSubscribed() && !isSnoozed()) open("scroll");
		}
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, [newsletterSlug, open]);

	return null;
}
