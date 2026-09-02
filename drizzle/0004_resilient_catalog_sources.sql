CREATE TABLE IF NOT EXISTS `catalog_sources` (
	`source` text PRIMARY KEY NOT NULL,
	`payload_json` text,
	`refreshed_at` text,
	`last_attempt_at` text NOT NULL,
	`last_error` text
);
