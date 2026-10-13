import "server-only";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { connectDb, db } from "@/db";
import { campaigns, contacts, newsletters, suppressions } from "@/db/schema";
import { getEmailStats, getHourlySends, getSubscriberHistory } from "@/lib/overview-data";
import { isSendingEnabled } from "@/lib/config";
import { newsletterBySlug } from "@/lib/operator-services";
import { OperatorError, readString } from "@/lib/operator-api";
import { getQueueDatabase } from "@/queue/connection";

export async function publicReadiness() {
  let databaseReady = false;
  let queueReady = false;
  try {
    await connectDb();
    databaseReady = db.get<{ value: number }>(sql`select 1 as value`)?.value === 1;
  } catch { /* Do not expose connection details in public readiness. */ }
  try {
    const row = getQueueDatabase().$client.prepare("SELECT 1 AS value").get() as { value: number } | undefined;
    queueReady = row?.value === 1;
  } catch { /* Queue migrations are checked by the native connection helper. */ }
  return { ok: databaseReady && queueReady, db: databaseReady ? "ready" : "unavailable", queue: queueReady ? "ready" : "unavailable", sendingEnabled: isSendingEnabled() };
}

export async function operatorHealth() {
  await connectDb();
  const result = db.get<{ value: number }>(sql`select 1 as value`);
  if (result?.value !== 1) throw new OperatorError(503, "database_unavailable", "Database readiness check failed");
  return { status: "ok", database: { status: "ok", engine: "sqlite" }, sendingEnabled: isSendingEnabled(), transport: process.env.EMAIL_TRANSPORT || "ses", time: new Date().toISOString() };
}

export async function operatorOverview(params: URLSearchParams) {
  for (const field of ["newsletter", "timeZone"]) if (params.getAll(field).length > 1) throw new OperatorError(400, "invalid_filter", `${field} may be specified only once`);
  const timeZone = params.has("timeZone") ? readString(params.get("timeZone"), "timeZone", { required: true, max: 100 })! : "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(); }
  catch { throw new OperatorError(400, "invalid_time_zone", "timeZone must be a valid IANA timezone"); }
  await connectDb();
  const snapshot = db.transaction((tx) => {
    const activeCount = count(contacts._id);
    const allNewsletters = tx.select({ _id: newsletters._id, name: newsletters.name, slug: newsletters.slug, activeCount })
      .from(newsletters).leftJoin(contacts, and(eq(contacts.newsletterId, newsletters._id), eq(contacts.status, "active")))
      .groupBy(newsletters._id).orderBy(desc(activeCount), newsletters._id).all();
    const selected = params.has("newsletter") ? newsletterBySlug(params.get("newsletter")) : allNewsletters[0] ?? null;
    return {
      newsletters: allNewsletters, selected,
      totals: {
        newsletters: tx.select({ value: count() }).from(newsletters).get()?.value ?? 0,
        contacts: tx.select({ value: count() }).from(contacts).get()?.value ?? 0,
        campaigns: tx.select({ value: count() }).from(campaigns).get()?.value ?? 0,
        suppressions: tx.select({ value: count() }).from(suppressions).get()?.value ?? 0,
      },
      contactStatuses: tx.select({ status: contacts.status, total: count() }).from(contacts).groupBy(contacts.status).all(),
      campaignStatuses: tx.select({ status: campaigns.status, total: count() }).from(campaigns).groupBy(campaigns.status).all(),
      recentCampaigns: selected ? tx.select().from(campaigns).where(eq(campaigns.newsletterId, selected._id)).orderBy(desc(campaigns.createdAt), desc(campaigns._id)).limit(5).all() : [],
    };
  });
  if (!snapshot.selected) return { ...snapshot, timeZone, emailStats: null, subscriberHistory: null, hourlySends: [], sendingEnabled: isSendingEnabled() };
  const newsletterId = snapshot.selected._id;
  const [emailStats, subscriberHistory, hourlySends] = await Promise.all([
    getEmailStats({ newsletterId }), getSubscriberHistory({ newsletterId, timeZone }), getHourlySends({ newsletterId, timeZone }),
  ]);
  return { ...snapshot, timeZone, emailStats, subscriberHistory, hourlySends, sendingEnabled: isSendingEnabled() };
}
