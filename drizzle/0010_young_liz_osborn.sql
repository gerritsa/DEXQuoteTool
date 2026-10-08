ALTER TABLE `volume_ingestion_state` ADD `budget_day` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `volume_ingestion_state` ADD `pages_today` integer DEFAULT 0 NOT NULL;