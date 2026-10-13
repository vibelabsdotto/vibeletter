CREATE TABLE `rate_limit_buckets` (
	`key` text PRIMARY KEY NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limit_expiry_idx` ON `rate_limit_buckets` (`expires_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `delivery_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `retry_deadline_at` integer;