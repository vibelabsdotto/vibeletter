CREATE TABLE `alerts` (
	`_id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`title` text,
	`last_sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_key_unique` ON `alerts` (`key`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`_id` text PRIMARY KEY NOT NULL,
	`newsletter_id` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`preview_text` text DEFAULT '' NOT NULL,
	`format` text DEFAULT 'rich' NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`html` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`audience_limit` integer,
	`source` text DEFAULT 'dashboard' NOT NULL,
	`scheduled_at` integer,
	`started_at` integer,
	`sent_at` integer,
	`test_sent_at` integer,
	`archive_slug` text,
	`thumbnail_url` text,
	`archive_listed` integer DEFAULT true NOT NULL,
	`archive_pinned` integer DEFAULT false NOT NULL,
	`web_views` integer DEFAULT 0 NOT NULL,
	`stats` text DEFAULT '{"recipients":0,"sent":0,"delivered":0,"bounced":0,"complained":0,"opened":0,"clicked":0,"unsubscribed":0,"failed":0}' NOT NULL,
	`last_chance` text DEFAULT '{"recipients":0,"sent":0,"delivered":0,"bounced":0,"complained":0,"failed":0,"dormant":0}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`newsletter_id`) REFERENCES `newsletters`(`_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `campaigns_newsletter_created_idx` ON `campaigns` (`newsletter_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `campaigns_status_schedule_idx` ON `campaigns` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `campaigns_started_idx` ON `campaigns` (`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_archive_slug_unique` ON `campaigns` (`archive_slug`) WHERE "campaigns"."archive_slug" is not null;--> statement-breakpoint
CREATE TABLE `contacts` (
	`_id` text PRIMARY KEY NOT NULL,
	`newsletter_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`source` text,
	`subscribed_at` integer NOT NULL,
	`confirmed_at` integer,
	`unsubscribed_at` integer,
	`last_sent_at` integer,
	`last_open_at` integer,
	`last_click_at` integer,
	`ignored_issues` integer,
	`last_engaged_at` integer,
	`last_chance_at` integer,
	`stats` text DEFAULT '{"sent":0,"opens":0,"clicks":0}' NOT NULL,
	`imported` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`newsletter_id`) REFERENCES `newsletters`(`_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_newsletter_email_unique` ON `contacts` (`newsletter_id`,`email`);--> statement-breakpoint
CREATE INDEX `contacts_email_idx` ON `contacts` (`email`);--> statement-breakpoint
CREATE INDEX `contacts_subscribed_idx` ON `contacts` (`subscribed_at`,`_id`);--> statement-breakpoint
CREATE INDEX `contacts_status_subscribed_idx` ON `contacts` (`status`,`subscribed_at`,`_id`);--> statement-breakpoint
CREATE INDEX `contacts_newsletter_subscribed_idx` ON `contacts` (`newsletter_id`,`subscribed_at`,`_id`);--> statement-breakpoint
CREATE INDEX `contacts_newsletter_status_subscribed_idx` ON `contacts` (`newsletter_id`,`status`,`subscribed_at`,`_id`);--> statement-breakpoint
CREATE INDEX `contacts_newsletter_last_chance_idx` ON `contacts` (`newsletter_id`,`last_chance_at`) WHERE "contacts"."last_chance_at" is not null;--> statement-breakpoint
CREATE TABLE `events` (
	`_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`ses_message_id` text,
	`message_id` text,
	`campaign_id` text,
	`email` text,
	`occurred_at` integer NOT NULL,
	`data` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_ses_id_idx` ON `events` (`ses_message_id`);--> statement-breakpoint
CREATE INDEX `events_campaign_type_idx` ON `events` (`campaign_id`,`type`);--> statement-breakpoint
CREATE TABLE `messages` (
	`_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`campaign_id` text,
	`newsletter_id` text NOT NULL,
	`contact_id` text,
	`email` text NOT NULL,
	`provider` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`ses_message_id` text,
	`error` text,
	`sent_at` integer,
	`delivered_at` integer,
	`opened_at` integer,
	`clicked_at` integer,
	`bounced_at` integer,
	`complained_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`newsletter_id`) REFERENCES `newsletters`(`_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_campaign_contact_unique` ON `messages` (`campaign_id`,`contact_id`) WHERE "messages"."kind" = 'campaign';--> statement-breakpoint
CREATE UNIQUE INDEX `messages_last_chance_contact_unique` ON `messages` (`campaign_id`,`contact_id`,`kind`) WHERE "messages"."kind" = 'last-chance';--> statement-breakpoint
CREATE INDEX `messages_ses_id_idx` ON `messages` (`ses_message_id`);--> statement-breakpoint
CREATE INDEX `messages_kind_created_idx` ON `messages` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_newsletter_sent_idx` ON `messages` (`newsletter_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `messages_campaign_status_idx` ON `messages` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `messages_contact_kind_idx` ON `messages` (`contact_id`,`kind`);--> statement-breakpoint
CREATE TABLE `newsletters` (
	`_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`image_url` text,
	`from_name` text,
	`from_email` text NOT NULL,
	`reply_to` text,
	`postal_address` text,
	`archive_enabled` integer DEFAULT false NOT NULL,
	`description` text,
	`social_links` text DEFAULT '[]' NOT NULL,
	`author` text DEFAULT '{}' NOT NULL,
	`require_confirmation` integer DEFAULT false NOT NULL,
	`cleanup` text DEFAULT '{"enabled":false}' NOT NULL,
	`welcome` text DEFAULT '{"enabled":false}' NOT NULL,
	`confirmation` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `newsletters_slug_unique` ON `newsletters` (`slug`);--> statement-breakpoint
CREATE INDEX `newsletters_created_idx` ON `newsletters` (`created_at`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_email_unique` ON `suppressions` (`email`);--> statement-breakpoint
CREATE TABLE `auth_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_account_user_idx` ON `auth_account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_account_provider_idx` ON `auth_account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `auth_session` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`development_only` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_session_token_unique` ON `auth_session` (`token`);--> statement-breakpoint
CREATE INDEX `auth_session_user_idx` ON `auth_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_user_email_unique` ON `auth_user` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_verification_identifier_idx` ON `auth_verification` (`identifier`);