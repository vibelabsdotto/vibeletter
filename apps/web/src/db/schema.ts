import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const createId = () => randomBytes(12).toString("hex");
export const CONTACT_STATUSES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"] as const;
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "paused", "sent", "canceled"] as const;
export const MESSAGE_STATUSES = ["queued", "sending", "sent", "delivered", "bounced", "complained", "failed", "suppressed", "unknown"] as const;
export const MESSAGE_KINDS = ["campaign", "last-chance", "welcome", "confirmation", "test"] as const;
export type CampaignStats = { recipients: number; sent: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number; unsubscribed: number; failed: number };
export type LastChanceStats = { recipients: number; sent: number; delivered: number; bounced: number; complained: number; failed: number; dormant: number };
export type ContactStats = { sent: number; opens: number; clicks: number };
export type EmailContent = { subject?: string; previewText?: string; markdown?: string };
export const emptyCampaignStats = (): CampaignStats => ({ recipients: 0, sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, unsubscribed: 0, failed: 0 });
export const emptyLastChanceStats = (): LastChanceStats => ({ recipients: 0, sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, dormant: 0 });
const identity = () => text("_id").primaryKey().$defaultFn(createId);
const timestamps = () => ({
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()).$onUpdateFn(() => new Date()),
});

export const newsletters = sqliteTable("newsletters", {
  _id: identity(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  imageUrl: text("image_url"),
  fromName: text("from_name"),
  fromEmail: text("from_email").notNull(),
  replyTo: text("reply_to"),
  postalAddress: text("postal_address"),
  archiveEnabled: integer("archive_enabled", { mode: "boolean" }).notNull().default(false),
  description: text("description"),
  socialLinks: text("social_links", { mode: "json" }).$type<string[]>().notNull().default([]),
  author: text("author", { mode: "json" }).$type<{ bio?: string; imageUrl?: string }>().notNull().default({}),
  requireConfirmation: integer("require_confirmation", { mode: "boolean" }).notNull().default(false),
  cleanup: text("cleanup", { mode: "json" }).$type<{ enabled?: boolean; issues?: number; days?: number }>().notNull().default({ enabled: false }),
  welcome: text("welcome", { mode: "json" }).$type<EmailContent & { enabled?: boolean }>().notNull().default({ enabled: false }),
  confirmation: text("confirmation", { mode: "json" }).$type<EmailContent>().notNull().default({}),
  ...timestamps(),
}, t => [index("newsletters_created_idx").on(t.createdAt)]);

export const campaigns = sqliteTable("campaigns", {
  _id: identity(),
  newsletterId: text("newsletter_id").notNull().references(() => newsletters._id, { onDelete: "restrict" }),
  subject: text("subject").notNull().default(""),
  previewText: text("preview_text").notNull().default(""),
  format: text("format", { enum: ["markdown", "html", "rich"] }).notNull().default("rich"),
  markdown: text("markdown").notNull().default(""),
  html: text("html").notNull().default(""),
  status: text("status", { enum: CAMPAIGN_STATUSES }).notNull().default("draft"),
  audienceLimit: integer("audience_limit"),
  source: text("source").notNull().default("dashboard"),
  scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  testSentAt: integer("test_sent_at", { mode: "timestamp_ms" }),
  archiveSlug: text("archive_slug"),
  thumbnailUrl: text("thumbnail_url"),
  archiveListed: integer("archive_listed", { mode: "boolean" }).notNull().default(true),
  archivePinned: integer("archive_pinned", { mode: "boolean" }).notNull().default(false),
  webViews: integer("web_views").notNull().default(0),
  stats: text("stats", { mode: "json" }).$type<CampaignStats>().notNull().default(emptyCampaignStats()),
  lastChance: text("last_chance", { mode: "json" }).$type<LastChanceStats>().notNull().default(emptyLastChanceStats()),
  ...timestamps(),
}, t => [
  index("campaigns_newsletter_created_idx").on(t.newsletterId, t.createdAt),
  index("campaigns_status_schedule_idx").on(t.status, t.scheduledAt),
  index("campaigns_started_idx").on(t.startedAt),
  uniqueIndex("campaigns_archive_slug_unique").on(t.archiveSlug).where(sql`${t.archiveSlug} is not null`),
]);

export const contacts = sqliteTable("contacts", {
  _id: identity(),
  newsletterId: text("newsletter_id").notNull().references(() => newsletters._id, { onDelete: "restrict" }),
  email: text("email").notNull(),
  status: text("status", { enum: CONTACT_STATUSES }).notNull().default("active"),
  source: text("source"),
  subscribedAt: integer("subscribed_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
  confirmationNonce: text("confirmation_nonce"),
  unsubscribedAt: integer("unsubscribed_at", { mode: "timestamp_ms" }),
  lastSentAt: integer("last_sent_at", { mode: "timestamp_ms" }),
  lastOpenAt: integer("last_open_at", { mode: "timestamp_ms" }),
  lastClickAt: integer("last_click_at", { mode: "timestamp_ms" }),
  ignoredIssues: integer("ignored_issues"),
  lastEngagedAt: integer("last_engaged_at", { mode: "timestamp_ms" }),
  lastChanceAt: integer("last_chance_at", { mode: "timestamp_ms" }),
  stats: text("stats", { mode: "json" }).$type<ContactStats>().notNull().default({ sent: 0, opens: 0, clicks: 0 }),
  imported: text("imported", { mode: "json" }).$type<{ emailsReceived?: number; openRate?: number; clickRate?: number; subscribedAtKnown?: boolean }>(),
  ...timestamps(),
}, t => [
  uniqueIndex("contacts_newsletter_email_unique").on(t.newsletterId, t.email),
  index("contacts_email_idx").on(t.email),
  index("contacts_subscribed_idx").on(t.subscribedAt, t._id),
  index("contacts_status_subscribed_idx").on(t.status, t.subscribedAt, t._id),
  index("contacts_newsletter_subscribed_idx").on(t.newsletterId, t.subscribedAt, t._id),
  index("contacts_newsletter_status_subscribed_idx").on(t.newsletterId, t.status, t.subscribedAt, t._id),
  index("contacts_newsletter_last_chance_idx").on(t.newsletterId, t.lastChanceAt).where(sql`${t.lastChanceAt} is not null`),
]);

export const messages = sqliteTable("messages", {
  _id: identity(),
  kind: text("kind", { enum: MESSAGE_KINDS }).notNull(),
  campaignId: text("campaign_id").references(() => campaigns._id, { onDelete: "set null" }),
  newsletterId: text("newsletter_id").notNull().references(() => newsletters._id, { onDelete: "restrict" }),
  contactId: text("contact_id").references(() => contacts._id, { onDelete: "set null" }),
  // Bind confirmation content and retries to the original consent generation.
  confirmationNonce: text("confirmation_nonce"),
  email: text("email").notNull(),
  provider: text("provider"),
  status: text("status", { enum: MESSAGE_STATUSES }).notNull().default("queued"),
  sesMessageId: text("ses_message_id"),
  error: text("error"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  retryDeadlineAt: integer("retry_deadline_at", { mode: "timestamp_ms" }),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  openedAt: integer("opened_at", { mode: "timestamp_ms" }),
  clickedAt: integer("clicked_at", { mode: "timestamp_ms" }),
  bouncedAt: integer("bounced_at", { mode: "timestamp_ms" }),
  complainedAt: integer("complained_at", { mode: "timestamp_ms" }),
  ...timestamps(),
}, t => [
  uniqueIndex("messages_campaign_contact_unique").on(t.campaignId, t.contactId).where(sql`${t.kind} = 'campaign'`),
  uniqueIndex("messages_last_chance_contact_unique").on(t.campaignId, t.contactId, t.kind).where(sql`${t.kind} = 'last-chance'`),
  index("messages_ses_id_idx").on(t.sesMessageId),
  index("messages_kind_created_idx").on(t.kind, t.createdAt),
  index("messages_newsletter_sent_idx").on(t.newsletterId, t.sentAt),
  index("messages_campaign_status_idx").on(t.campaignId, t.status),
  index("messages_contact_kind_idx").on(t.contactId, t.kind),
]);

export const events = sqliteTable("events", {
  _id: identity(),
  type: text("type").notNull(),
  sesMessageId: text("ses_message_id"),
  messageId: text("message_id").references(() => messages._id, { onDelete: "set null" }),
  campaignId: text("campaign_id").references(() => campaigns._id, { onDelete: "set null" }),
  email: text("email"),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
  ...timestamps(),
}, t => [index("events_ses_id_idx").on(t.sesMessageId), index("events_campaign_type_idx").on(t.campaignId, t.type)]);

export const suppressions = sqliteTable("suppressions", {
  _id: identity(),
  email: text("email").notNull().unique(),
  reason: text("reason", { enum: ["bounce", "complaint", "manual"] }).notNull(),
  detail: text("detail"),
  ...timestamps(),
});
export const apiKeys = sqliteTable("api_keys", {
  _id: identity(), name: text("name").notNull(), prefix: text("prefix").notNull(), hash: text("hash").notNull().unique(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  // Unknown legacy issuance is quarantined; production issuance explicitly opts out.
  developmentOnly: integer("development_only", { mode: "boolean" }).notNull().default(true),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  ...timestamps(),
});
export const alerts = sqliteTable("alerts", {
  _id: identity(), key: text("key").notNull().unique(), title: text("title"),
  lastSentAt: integer("last_sent_at", { mode: "timestamp_ms" }), ...timestamps(),
});

export const rateLimitBuckets = sqliteTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  hits: integer("hits").notNull().default(0),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, t => [index("rate_limit_expiry_idx").on(t.expiresAt)]);

export type Newsletter = typeof newsletters.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Suppression = typeof suppressions.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
