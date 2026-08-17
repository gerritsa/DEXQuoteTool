CREATE TABLE IF NOT EXISTS `benchmark_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pair_id` text NOT NULL,
	`amount_id` text NOT NULL,
	`source_asset` text NOT NULL,
	`destination_asset` text NOT NULL,
	`source_amount_base_units` text NOT NULL,
	`source_amount_usd` real NOT NULL,
	`source_price_usd` real NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`initiated_at` text NOT NULL,
	`completed_at` text,
	`max_request_skew_ms` integer,
	`sweep_id` text,
	`bundle_index` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_benchmark_runs_pair_created` ON `benchmark_runs` (`pair_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_benchmark_runs_pair_amount_created` ON `benchmark_runs` (`pair_id`,`amount_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_benchmark_runs_sweep_job` ON `benchmark_runs` (`sweep_id`,`pair_id`,`amount_id`,`mode`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `collector_bundles` (
	`id` text PRIMARY KEY NOT NULL,
	`sweep_id` text NOT NULL,
	`bundle_index` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`job_count` integer NOT NULL,
	`completed_jobs` integer DEFAULT 0 NOT NULL,
	`failed_jobs` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`normalized_archive_key` text,
	`raw_archive_key` text,
	`started_at` text,
	`completed_at` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`sweep_id`) REFERENCES `collector_sweeps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_collector_bundles_sweep` ON `collector_bundles` (`sweep_id`,`bundle_index`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `collector_sweeps` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduled_for` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`route_count` integer NOT NULL,
	`job_count` integer NOT NULL,
	`bundle_count` integer NOT NULL,
	`completed_jobs` integer DEFAULT 0 NOT NULL,
	`failed_jobs` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_collector_sweeps_scheduled` ON `collector_sweeps` (`scheduled_for`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `daily_comparison_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`pair_id` text NOT NULL,
	`amount_id` text NOT NULL,
	`mode` text NOT NULL,
	`protocol_mask` text NOT NULL,
	`protocol` text NOT NULL,
	`attempts` integer NOT NULL,
	`successes` integer NOT NULL,
	`comparable_samples` integer NOT NULL,
	`edge_sum_bps` real DEFAULT 0 NOT NULL,
	`wins` real NOT NULL,
	`latest_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_daily_metrics_lookup` ON `daily_comparison_metrics` (`pair_id`,`amount_id`,`mode`,`day`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_daily_metrics_day_mask` ON `daily_comparison_metrics` (`day`,`protocol_mask`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `latest_quote_payloads` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` integer NOT NULL,
	`pair_id` text NOT NULL,
	`amount_id` text NOT NULL,
	`mode` text NOT NULL,
	`protocol` text NOT NULL,
	`request_url` text,
	`request_payload_json` text,
	`raw_response_json` text,
	`error_message` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_latest_quote_payloads_lookup` ON `latest_quote_payloads` (`pair_id`,`amount_id`,`mode`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `protocol_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`protocol` text NOT NULL,
	`strategy` text NOT NULL,
	`status` text NOT NULL,
	`expected_output_base_units` text,
	`expected_output_formatted` text,
	`quoted_fee_usd` real,
	`estimated_duration_seconds` integer,
	`request_started_at` text NOT NULL,
	`response_received_at` text,
	`quote_expires_at` text,
	`request_url` text,
	`response_http_status` integer,
	`response_latency_ms` integer,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_protocol_quotes_run_protocol` ON `protocol_quotes` (`run_id`,`protocol`);
