CREATE TABLE `benchmark_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pair_id` text NOT NULL,
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
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_benchmark_runs_pair_created` ON `benchmark_runs` (`pair_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `protocol_quotes` (
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
	`raw_response_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_protocol_quotes_run_protocol` ON `protocol_quotes` (`run_id`,`protocol`);