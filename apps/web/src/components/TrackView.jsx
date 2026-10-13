"use client";

import { useEffect } from "react";
import { readStoredNumber, storeValue, viewedKey } from "@/lib/storage";

const VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

// One view per issue, browser and day; a refresh or a second visit the same day doesn't count again.
export default function TrackView({ issueId }) {
	useEffect(() => {
		const key = viewedKey(issueId);
		if (Date.now() - readStoredNumber(key) < VIEW_WINDOW_MS) return;
		storeValue(key, Date.now());

		const body = JSON.stringify({ id: issueId });
		const isQueued = navigator.sendBeacon?.("/api/views", new Blob([body], { type: "application/json" }));
		if (!isQueued) {
			fetch("/api/views", {
				method: "POST",
				body,
				keepalive: true,
				headers: { "Content-Type": "application/json" },
			}).catch(() => {});
		}
	}, [issueId]);

	return null;
}
