ALTER TABLE `benchmark_runs` ADD `oracle_source_price_usd` real;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `oracle_destination_price_usd` real;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `oracle_reference_output` real;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `oracle_captured_at` text;--> statement-breakpoint
ALTER TABLE `daily_comparison_metrics` ADD `oracle_samples` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_comparison_metrics` ADD `oracle_gap_sum_bps` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `protocol_quotes` ADD `oracle_gap_bps` real;--> statement-breakpoint
DELETE FROM `latest_quote_payloads`;--> statement-breakpoint
DELETE FROM `protocol_quotes`;--> statement-breakpoint
DELETE FROM `benchmark_runs`;--> statement-breakpoint
DELETE FROM `collector_bundles`;--> statement-breakpoint
DELETE FROM `collector_sweeps`;--> statement-breakpoint
DELETE FROM `daily_comparison_metrics`;--> statement-breakpoint
DELETE FROM `trend_buckets`;
