const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEK_MS = 7 * DAY_MS;
const SLOT_MS = 15 * MINUTE_MS;
const MIN_LEAD_MS = MINUTE_MS;
const MAX_AHEAD_MS = 365 * DAY_MS;
// Suggestions leave time to look the issue over before it goes out.
const SUGGESTION_LEAD_MS = 10 * MINUTE_MS;
// Another issue of the newsletter going out this close takes the slot, so the suggestion moves a week on.
const TAKEN_WINDOW_MS = 12 * 60 * MINUTE_MS;
const MAX_SUGGESTIONS = 3;

export function getScheduleProblem(value, now = Date.now()) {
	const time = new Date(value ?? NaN).getTime();
	if (!Number.isFinite(time)) return "Pick a date and time";
	if (time < now + MIN_LEAD_MS) return "Pick a time in the future";
	if (time > now + MAX_AHEAD_MS) return "Pick a time within a year";
	return null;
}

// Past sends become upcoming dates: the same weekday and time, the next time it comes around.
// Slots are in UTC, so readers keep getting issues at their usual hour wherever the sender is.
// history is newest first; the first slot is the last issue's.
export function getScheduleSuggestions({ history = [], taken = [], now = Date.now() } = {}) {
	const takenTimes = taken.map(toTime).filter(Number.isFinite);
	const slots = [];
	for (const time of history.map(toTime).filter(Number.isFinite)) {
		const offset = weekOffset(Math.round(time / SLOT_MS) * SLOT_MS);
		const slot = slots.find((existing) => existing.offset === offset);
		if (slot) slot.uses += 1;
		else slots.push({ offset, uses: 1, lastUsedAt: new Date(time), isLastIssue: slots.length === 0 });
	}

	return slots
		.slice(0, MAX_SUGGESTIONS)
		.map(({ offset, ...slot }) => ({ ...slot, at: new Date(nextFreeTime(offset, now, takenTimes)) }))
		.sort((a, b) => a.at - b.at);
}

function toTime(value) {
	return value ? new Date(value).getTime() : NaN;
}

function startOfUtcWeek(time) {
	const date = new Date(time);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay());
}

function weekOffset(time) {
	return time - startOfUtcWeek(time);
}

function nextFreeTime(offset, now, takenTimes) {
	const earliest = now + SUGGESTION_LEAD_MS;
	let time = startOfUtcWeek(earliest) + offset;
	if (time < earliest) time += WEEK_MS;
	while (takenTimes.some((taken) => Math.abs(taken - time) < TAKEN_WINDOW_MS)) time += WEEK_MS;
	return time;
}
