// localStorage throws when the browser blocks storage; the archive then just forgets.
export function readStoredNumber(key) {
	try {
		let value = localStorage.getItem(key);
		// Keep archive preferences and view deduplication when an upstream instance is renamed.
		if (value === null && key.startsWith("vibeletter:")) {
			value = localStorage.getItem(key.replace(/^vibeletter:/, "mailcheap:"));
			if (value !== null) storeValue(key, value);
		}
		return Number(value) || 0;
	} catch {
		return 0;
	}
}

export function storeValue(key, value) {
	try {
		localStorage.setItem(key, String(value));
	} catch {}
}

export function subscribedKey(newsletterSlug) {
	return `vibeletter:subscribed:${newsletterSlug}`;
}

export function subscribeSnoozedKey(newsletterSlug) {
	return `vibeletter:subscribe-snoozed:${newsletterSlug}`;
}

export function viewedKey(issueId) {
	return `vibeletter:viewed:${issueId}`;
}
