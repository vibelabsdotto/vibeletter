import "server-only";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";

type ReportStore = Pick<typeof db, "select">;

/** The dashboard and operator reports share the same campaign-only provider counts. */
export function getProviderBreakdown(campaignId: string, store: ReportStore = db) {
  const provider = sql<string>`coalesce(${messages.provider}, 'other')`;
  const sent = count(messages.sentAt);
  return store.select({
    provider,
    sent,
    delivered: count(messages.deliveredAt),
    opened: count(messages.openedAt),
    clicked: count(messages.clickedAt),
    bounced: count(messages.bouncedAt),
    complained: count(messages.complainedAt),
  }).from(messages)
    .where(and(eq(messages.campaignId, campaignId), eq(messages.kind, "campaign")))
    .groupBy(provider)
    .having(sql`${sent} > 0`)
    .orderBy(desc(sent), provider)
    .all();
}
