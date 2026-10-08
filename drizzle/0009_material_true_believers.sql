CREATE TABLE `route_quote_hourly` (
	`id` text PRIMARY KEY NOT NULL,
	`route_key` integer NOT NULL,
	`hour` integer NOT NULL,
	`scores_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_route_quote_hourly_lookup` ON `route_quote_hourly` (`route_key`,`hour`);--> statement-breakpoint
CREATE INDEX `idx_route_quote_hourly_expiry` ON `route_quote_hourly` (`hour`);--> statement-breakpoint
CREATE TABLE `route_volume_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`route_key` integer NOT NULL,
	`days` integer NOT NULL,
	`payload_json` text NOT NULL,
	`revision` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `volume_feed_hours` (
	`id` text PRIMARY KEY NOT NULL,
	`protocol` text NOT NULL,
	`hour` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`cursor` text,
	`pages` integer DEFAULT 0 NOT NULL,
	`records` integer DEFAULT 0 NOT NULL,
	`pending` integer DEFAULT 0 NOT NULL,
	`next_attempt` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_volume_feed_work` ON `volume_feed_hours` (`protocol`,`status`,`next_attempt`,`hour`);--> statement-breakpoint
CREATE INDEX `idx_volume_feed_expiry` ON `volume_feed_hours` (`hour`);--> statement-breakpoint
CREATE TABLE `volume_hourly` (
	`id` text PRIMARY KEY NOT NULL,
	`route_key` integer NOT NULL,
	`protocol` text NOT NULL,
	`hour` integer NOT NULL,
	`totals_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_volume_hourly_route_hour` ON `volume_hourly` (`route_key`,`hour`);--> statement-breakpoint
CREATE INDEX `idx_volume_hourly_expiry` ON `volume_hourly` (`hour`);--> statement-breakpoint
CREATE TABLE `volume_ingestion_state` (
	`protocol` text PRIMARY KEY NOT NULL,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`next_request` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `volume_recent_swaps` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`generation` integer NOT NULL,
	`route_key` integer NOT NULL,
	`usd_micros` text,
	`pending` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_volume_recent_job` ON `volume_recent_swaps` (`job_id`,`generation`);--> statement-breakpoint
CREATE INDEX `idx_volume_recent_expiry` ON `volume_recent_swaps` (`created_at`);--> statement-breakpoint
CREATE TABLE `volume_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`route_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `volume_routes_route_id_unique` ON `volume_routes` (`route_id`);