CREATE TABLE `trend_buckets` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket_start` text NOT NULL,
	`bucket_seconds` integer NOT NULL,
	`pair_id` text NOT NULL,
	`amount_id` text NOT NULL,
	`mode` text NOT NULL,
	`samples_json` text NOT NULL,
	`latest_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_trend_buckets_lookup` ON `trend_buckets` (`pair_id`,`amount_id`,`mode`,`bucket_seconds`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `idx_trend_buckets_retention` ON `trend_buckets` (`bucket_seconds`,`bucket_start`);--> statement-breakpoint
DELETE FROM `latest_quote_payloads`;--> statement-breakpoint
DELETE FROM `protocol_quotes`;--> statement-breakpoint
DELETE FROM `daily_comparison_metrics`;--> statement-breakpoint
DELETE FROM `collector_bundles`;--> statement-breakpoint
DELETE FROM `benchmark_runs`;--> statement-breakpoint
DELETE FROM `collector_sweeps`;--> statement-breakpoint
DELETE FROM `sqlite_sequence` WHERE `name` IN ('benchmark_runs', 'protocol_quotes');--> statement-breakpoint
PRAGMA optimize;
