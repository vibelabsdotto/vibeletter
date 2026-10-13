"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { TIME_ZONE_COOKIE } from "@/lib/time-zone";

// Saves the browser's timezone for the server, which counts the overview's days and hours in it.
// Compares with the cookie itself, not the server's reading of it, so it refreshes at most once.
export default function CookieTimezone() {
	const router = useRouter();

	useEffect(() => {
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const saved = document.cookie.match(new RegExp(`(?:^|; )${TIME_ZONE_COOKIE}=([^;]*)`))?.[1];
		if (!timeZone || decodeURIComponent(saved ?? "") === timeZone) return;
		document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(timeZone)}; path=/; max-age=31536000; samesite=lax`;
		router.refresh();
	}, [router]);

	return null;
}
