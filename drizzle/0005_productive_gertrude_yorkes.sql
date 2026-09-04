CREATE TABLE `pool_depth_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`captured_at` text NOT NULL,
	`pools_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pool_depth_snapshots_captured` ON `pool_depth_snapshots` (`captured_at`);--> statement-breakpoint
ALTER TABLE `benchmark_runs` ADD `depth_forecast_json` text;
