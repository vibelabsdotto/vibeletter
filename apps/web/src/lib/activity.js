const MAX_USER_AGENT_LENGTH = 160;

export function formatActivity(lines, { ip, country, userAgent }) {
	const where = `IP ${ip}${country ? ` (${country})` : ""}`;
	const browser = userAgent === undefined ? null : (userAgent || "No user agent").slice(0, MAX_USER_AGENT_LENGTH);
	return [...lines, where, browser].filter(Boolean).join("\n");
}
