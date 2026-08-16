CREATE TABLE `benchmark_cycles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text DEFAULT 'thorchain_top_20' NOT NULL,
	`ranking_window` text DEFAULT '24h_pool_activity' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`route_count` integer DEFAULT 20 NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`successful_quote_count` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_benchmark_cycles_created` ON `benchmark_cycles` (`created_at`);--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `cycle_id` integer REFERENCES benchmark_cycles(id);--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `range_id` text DEFAULT 'unassigned' NOT NULL;--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `sample_point` text DEFAULT 'scheduled_midpoint' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_benchmark_runs_pair_range_created` ON `benchmark_runs` (`pair_id`,`range_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_benchmark_runs_cycle` ON `benchmark_runs` (`cycle_id`);--> statement-breakpoint
ALTER TABLE `protocol_quotes` ADD `request_url` text;--> statement-breakpoint
ALTER TABLE `protocol_quotes` ADD `request_payload_json` text;--> statement-breakpoint
ALTER TABLE `protocol_quotes` ADD `response_http_status` integer;--> statement-breakpoint
ALTER TABLE `protocol_quotes` ADD `response_latency_ms` integer;