// Amber at half the pause threshold, red once the campaign would be auto-paused.
export function rateTone(part, total, limit) {
	if (!total) return "default";
	const rate = part / total;
	if (rate >= limit) return "bad";
	if (rate >= limit / 2) return "warn";
	return "default";
}
