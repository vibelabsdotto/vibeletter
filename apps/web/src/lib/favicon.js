// Second-level labels under which a registrable domain takes three labels (example.co.uk).
const SECOND_LEVEL_LABELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);

export function rootDomain(hostOrEmail) {
	const host = String(hostOrEmail ?? "")
		.toLowerCase()
		.split("@")
		.pop()
		.trim();
	const labels = host.split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const isTwoLevelSuffix = SECOND_LEVEL_LABELS.has(labels.at(-2)) && labels.at(-1).length === 2;
	return labels.slice(isTwoLevelSuffix ? -3 : -2).join(".");
}

// Google's resolver returns a sized PNG for any domain, and a generic globe when it finds none.
export function faviconUrl(domain, size = 64) {
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}
