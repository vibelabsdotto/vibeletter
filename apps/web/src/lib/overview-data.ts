import "server-only";
import { and, count, eq, gte, inArray, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { connectDb, db } from "@/db";
import { campaigns, contacts, messages, suppressions } from "@/db/schema";
import { PERIOD_DAYS, buildHourlySeries, buildSubscriberSeries, periodDayKeys, splitPeriods } from "@/lib/overview-series";
import { hourIn, resolveTimeZone, shiftDateKey, startOfDateKey, toDateKey } from "@/lib/time-zone";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const STAT_KEYS = ["sent", "delivered", "opened", "clicked", "bounced", "complained"] as const;
type StatKey = typeof STAT_KEYS[number];
type Stats = Record<StatKey, number>;
const LEFT_STATUSES = ["unsubscribed", "bounced", "complained"] as const;
const IMPORT_SOURCES = ["import"];
// Imports record pre-existing unsubscribes near creation, not a known leave date in this app.
const IMPORT_WINDOW_MS = 60_000;

// SQLite has no IANA timezone database. Compute this bounded calendar's DST-aware edges in JS;
// SQL still filters, groups and counts the records. Only aggregate rows leave the database.
function calendarBuckets(dayKeys: string[], timeZone: string) {
	return dayKeys.map((key) => ({ key, end: startOfDateKey(shiftDateKey(key, 1), timeZone).getTime() }));
}

function dayBucket(at: SQL | typeof contacts.unsubscribedAt | typeof suppressions.createdAt,
	buckets: ReturnType<typeof calendarBuckets>) {
	return sql<string | null>`case ${sql.join(buckets.map(({ key, end }) => sql`when ${at} < ${end} then ${key}`), sql.raw(" "))} else ${"9999-12-31"} end`;
}

// Use the latest recorded signup/confirmation date.
const joinedAt = sql<number | null>`max(coalesce(${contacts.subscribedAt}, ${contacts.confirmedAt}), coalesce(${contacts.confirmedAt}, ${contacts.subscribedAt}))`;
const joinDateKnown = sql<number | null>`json_extract(${contacts.imported}, '$.subscribedAtKnown')`;
const joinedBeforeImport = sql`(${joinDateKnown} = 0 or (${joinDateKnown} is null and ${inArray(contacts.source, IMPORT_SOURCES)} and abs(${contacts.subscribedAt} - ${contacts.createdAt}) < ${IMPORT_WINDOW_MS}))`;

function joinedDay(rangeStart: Date, buckets: ReturnType<typeof calendarBuckets>) {
	return sql<string | null>`case when ${joinedBeforeImport} or ${joinedAt} is null or ${joinedAt} < ${rangeStart.getTime()} then null else ${dayBucket(joinedAt, buckets)} end`;
}

// Active subscribers at each day's end, including known unsubscribes, bounces and complaints.
// Imported contacts with unknown original join dates contribute to the baseline, not an import spike.
export async function getSubscriberHistory({ newsletterId, timeZone, now = new Date() }: {
	newsletterId: string; timeZone: string; now?: Date;
}) {
	await connectDb();
	const zone = resolveTimeZone(timeZone);
	const dayKeys = periodDayKeys(toDateKey(now, zone));
	const rangeStart = startOfDateKey(dayKeys[0], zone);
	const buckets = calendarBuckets(dayKeys, zone);
	const joined = joinedDay(rangeStart, buckets);
	const unsubscribed = dayBucket(contacts.unsubscribedAt, buckets);
	const suppressed = dayBucket(suppressions.createdAt, buckets);

	const activeBefore = db.select({ count: count() }).from(contacts)
		.where(and(eq(contacts.newsletterId, newsletterId), eq(contacts.status, "active"), lt(contacts.subscribedAt, rangeStart)))
		.get()?.count ?? 0;
	const activeJoins = db.select({ joined, count: count() }).from(contacts)
		.where(and(eq(contacts.newsletterId, newsletterId), eq(contacts.status, "active"), gte(contacts.subscribedAt, rangeStart)))
		.groupBy(joined).all();
	const unsubscribes = db.select({ joined, left: unsubscribed, count: count() }).from(contacts)
		.where(and(
			eq(contacts.newsletterId, newsletterId), inArray(contacts.status, [...LEFT_STATUSES]),
			gte(contacts.unsubscribedAt, rangeStart),
			sql`${contacts.unsubscribedAt} > ${contacts.createdAt} + ${IMPORT_WINDOW_MS}`,
		)).groupBy(joined, unsubscribed).all();
	// Prefer a known unsubscribe date over suppression time, exactly once per suppressed address.
	const suppressionRows = db.select({ joined, left: suppressed, count: count() }).from(suppressions)
		.innerJoin(contacts, eq(contacts.email, suppressions.email))
		.where(and(
			eq(contacts.newsletterId, newsletterId), inArray(contacts.status, ["bounced", "complained"]),
			inArray(suppressions.reason, ["bounce", "complaint"]),
			or(isNull(suppressions.detail), notInArray(suppressions.detail, IMPORT_SOURCES)),
			gte(suppressions.createdAt, rangeStart),
			sql`${suppressions.createdAt} > ${contacts.createdAt} + ${IMPORT_WINDOW_MS}`,
			or(isNull(contacts.unsubscribedAt), sql`${contacts.unsubscribedAt} <= ${contacts.createdAt} + ${IMPORT_WINDOW_MS}`),
		)).groupBy(joined, suppressed).all();

	let baseline = activeBefore;
	const joins: Record<string, number> = {};
	const leaves: Record<string, number> = {};
	for (const row of activeJoins) {
		if (row.joined) joins[row.joined] = (joins[row.joined] ?? 0) + row.count;
		else baseline += row.count;
	}
	for (const row of [...unsubscribes, ...suppressionRows]) {
		if (row.joined) joins[row.joined] = (joins[row.joined] ?? 0) + row.count;
		else baseline += row.count;
		if (row.left) leaves[row.left] = (leaves[row.left] ?? 0) + row.count;
	}
	return splitPeriods(buildSubscriberSeries({ dayKeys, baseline, joins, leaves }));
}

function emptyStats(): Stats {
	return Object.fromEntries(STAT_KEYS.map((key) => [key, 0])) as Stats;
}

// Issues and welcome emails of the last 30 days and the preceding 30 days.
export async function getEmailStats({ newsletterId, now = new Date() }: { newsletterId: string; now?: Date }) {
	await connectDb();
	const since = now.getTime() - PERIOD_DAYS * DAY_MS;
	const previousSince = now.getTime() - 2 * PERIOD_DAYS * DAY_MS;
	const at = sql<number>`coalesce(${campaigns.startedAt}, ${campaigns.sentAt})`;
	const campaignPeriod = sql<"current" | "previous">`case when ${at} >= ${since} then 'current' else 'previous' end`;
	const welcomePeriod = sql<"current" | "previous">`case when ${messages.createdAt} >= ${since} then 'current' else 'previous' end`;
	const campaignStats = Object.fromEntries(STAT_KEYS.map((key) => [key,
		sql<number>`coalesce(sum(json_extract(${campaigns.stats}, ${`$.${key}`})), 0)`,
	])) as Record<StatKey, SQL<number>>;
	const messageDates = {
		sent: messages.sentAt, delivered: messages.deliveredAt, opened: messages.openedAt,
		clicked: messages.clickedAt, bounced: messages.bouncedAt, complained: messages.complainedAt,
	};
	const welcomeStats = Object.fromEntries(STAT_KEYS.map((key) => [key,
		sql<number>`sum(case when ${messageDates[key]} is not null then 1 else 0 end)`,
	])) as Record<StatKey, SQL<number>>;
	const campaignRows = db.select({ period: campaignPeriod, ...campaignStats }).from(campaigns)
		.where(and(eq(campaigns.newsletterId, newsletterId), gte(at, previousSince)))
		.groupBy(campaignPeriod).all();
	const welcomeRows = db.select({ period: welcomePeriod, ...welcomeStats }).from(messages)
		.where(and(eq(messages.newsletterId, newsletterId), eq(messages.kind, "welcome"), gte(messages.createdAt, new Date(previousSince))))
		.groupBy(welcomePeriod).all();
	const totals = { current: emptyStats(), previous: emptyStats() };
	for (const row of [...campaignRows, ...welcomeRows]) {
		for (const key of STAT_KEYS) totals[row.period][key] += row[key] || 0;
	}
	return totals;
}

function hourlyBuckets(since: Date, until: Date, timeZone: string) {
	const buckets: { key: string; end: number }[] = [];
	let key = "";
	// IANA offsets in the displayed range have minute precision. This also handles fractional-hour
	// offsets and half-hour DST changes. Repeated local hours group into the same SQL bucket key.
	for (let at = since.getTime(); at < until.getTime(); at += MINUTE_MS) {
		const date = new Date(at);
		const nextKey = `${toDateKey(date, timeZone)} ${hourIn(date, timeZone)}`;
		if (key && key !== nextKey) buckets.push({ key, end: at });
		key = nextKey;
	}
	if (key) buckets.push({ key, end: until.getTime() });
	return buckets;
}

// All SES-accepted emails, including confirmation and test messages, by local hour.
export async function getHourlySends({ newsletterId, timeZone, now = new Date() }: {
	newsletterId: string; timeZone: string; now?: Date;
}) {
	await connectDb();
	const zone = resolveTimeZone(timeZone);
	const todayKey = toDateKey(now, zone);
	const since = startOfDateKey(shiftDateKey(todayKey, -1), zone);
	const until = startOfDateKey(shiftDateKey(todayKey, 1), zone);
	const bucket = sql<string>`case ${sql.join(hourlyBuckets(since, until, zone)
		.map(({ key, end }) => sql`when ${messages.sentAt} < ${end} then ${key}`), sql.raw(" "))} else null end`;
	const rows = db.select({ bucket, count: count() }).from(messages)
		.where(and(eq(messages.newsletterId, newsletterId), gte(messages.sentAt, since), lt(messages.sentAt, until)))
		.groupBy(bucket).all();
	return buildHourlySeries({
		rows: rows.map(({ bucket: key, count }) => {
			const [day, hour] = key.split(" ");
			return { day, hour: Number(hour), count };
		}),
		todayKey,
		currentHour: hourIn(now, zone),
	});
}
