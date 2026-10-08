ALTER TABLE `volume_ingestion_state` ADD `background_pages_today` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Account conservatively for requests already made before the split budget.
UPDATE `volume_ingestion_state` SET `background_pages_today` = `pages_today`;
