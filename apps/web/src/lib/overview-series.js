import { shiftDateKey } from "./time-zone.js";

export const PERIOD_DAYS = 30;

// The previous period's days, then the current one's; the last key is today.
export function periodDayKeys(todayKey, days = PERIOD_DAYS) {
	return Array.from({ length: days * 2 }, (_, index) => shiftDateKey(todayKey, index - days * 2 + 1));
}

// Subscribers at the end of each day: the count when the range starts, plus joins, minus leaves.
// Events dated before the range fold into the starting count; later ones are ignored.
export function buildSubscriberSeries({ dayKeys, baseline, joins = {}, leaves = {} }) {
	const firstKey = dayKeys[0];
	let start = baseline;
	for (const [key, count] of Object.entries(joins)) if (key < firstKey) start += count;
	for (const [key, count] of Object.entries(leaves)) if (key < firstKey) start -= count;

	let total = start;
	const days = dayKeys.map((key) => {
		const joined = joins[key] ?? 0;
		const left = leaves[key] ?? 0;
		total += joined - left;
		return { key, total, joined, left };
	});
	return { start, days };
}

export function splitPeriods({ start, days }, periodDays = PERIOD_DAYS) {
	const previous = days.slice(0, periodDays);
	const current = days.slice(periodDays);
	const previousEnd = previous.at(-1)?.total ?? start;
	return {
		previous,
		current,
		total: current.at(-1)?.total ?? previousEnd,
		growth: (current.at(-1)?.total ?? previousEnd) - previousEnd,
		previousGrowth: previousEnd - start,
	};
}

// 24 hourly buckets of today and yesterday from { day, hour, count } rows. Hours still to come are null.
export function buildHourlySeries({ rows, todayKey, currentHour }) {
	const yesterdayKey = shiftDateKey(todayKey, -1);
	const counts = new Map(rows.map(({ day, hour, count }) => [`${day} ${hour}`, count]));
	return Array.from({ length: 24 }, (_, hour) => ({
		hour,
		today: hour > currentHour ? null : (counts.get(`${todayKey} ${hour}`) ?? 0),
		yesterday: counts.get(`${yesterdayKey} ${hour}`) ?? 0,
	}));
}

// Change of a count in percent, or of a rate in percentage points. Null when there's nothing to compare.
export function compareCount(current, previous) {
	if (!previous) return null;
	return ((current - previous) / previous) * 100;
}

export function compareRate(part, total, previousPart, previousTotal) {
	if (!total || !previousTotal) return null;
	return ((part / total) - (previousPart / previousTotal)) * 100;
}
