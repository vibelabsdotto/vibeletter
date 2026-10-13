"use client";

import { useIsClient } from "@/lib/use-is-client";

export default function TimeLocal({ value, options }) {
	const isClient = useIsClient();
	const date = new Date(value);

	return <time dateTime={date.toISOString()}>{isClient ? date.toLocaleString("en-US", options) : null}</time>;
}
