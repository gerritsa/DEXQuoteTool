ALTER TABLE `collector_sweeps` ADD `missing_routes_json` text;--> statement-breakpoint
CREATE INDEX `idx_benchmark_runs_initiated` ON `benchmark_runs` (`initiated_at`);--> statement-breakpoint
PRAGMA optimize;
