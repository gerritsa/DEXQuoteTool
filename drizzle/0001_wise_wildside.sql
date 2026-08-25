CREATE TABLE `catalog_state` (
	`id` text PRIMARY KEY NOT NULL,
	`assets_json` text,
	`refreshed_at` text,
	`last_attempt_at` text NOT NULL,
	`last_error` text
);
