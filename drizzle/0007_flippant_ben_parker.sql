DELETE FROM `pool_depth_snapshots`;--> statement-breakpoint
CREATE TABLE `__new_daily_comparison_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`pair_id` text NOT NULL,
	`amount_id` text NOT NULL,
	`mode` text NOT NULL,
	`metrics_json` text NOT NULL,
	`latest_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_daily_comparison_metrics` (
  `id`, `day`, `pair_id`, `amount_id`, `mode`, `metrics_json`, `latest_at`, `created_at`
)
WITH base_metrics AS (
  SELECT `day`, `pair_id`, `amount_id`, `mode`, `protocol`,
    MAX(`attempts`) AS `attempts`,
    MAX(`successes`) AS `successes`,
    MAX(`comparable_samples`) AS `comparable_samples`,
    MAX(`oracle_samples`) AS `oracle_samples`,
    MAX(`oracle_gap_sum_bps`) AS `oracle_gap_sum_bps`,
    MAX(`latest_at`) AS `latest_at`,
    MIN(`created_at`) AS `created_at`
  FROM `daily_comparison_metrics`
  WHERE `mode` = 'optimized'
  GROUP BY `day`, `pair_id`, `amount_id`, `mode`, `protocol`
), protocol_payloads AS (
  SELECT `day`, `pair_id`, `amount_id`, `mode`,
    json_group_object(`protocol`, json_array(
      `attempts`, `successes`, `comparable_samples`, `oracle_samples`, `oracle_gap_sum_bps`
    )) AS `protocols_json`,
    MAX(`latest_at`) AS `latest_at`,
    MIN(`created_at`) AS `created_at`
  FROM base_metrics
  GROUP BY `day`, `pair_id`, `amount_id`, `mode`
), mask_payloads AS (
  SELECT `day`, `pair_id`, `amount_id`, `mode`, `protocol_mask`,
    json_group_object(`protocol`, `wins`) AS `mask_json`
  FROM `daily_comparison_metrics`
  WHERE `mode` = 'optimized'
  GROUP BY `day`, `pair_id`, `amount_id`, `mode`, `protocol_mask`
), win_payloads AS (
  SELECT `day`, `pair_id`, `amount_id`, `mode`,
    json_group_object(`protocol_mask`, json(`mask_json`)) AS `wins_json`
  FROM mask_payloads
  GROUP BY `day`, `pair_id`, `amount_id`, `mode`
)
SELECT
  p.`day` || '|' || p.`pair_id` || '|' || p.`amount_id` || '|' || p.`mode`,
  p.`day`, p.`pair_id`, p.`amount_id`, p.`mode`,
  json_object('p', json(p.`protocols_json`), 'w', json(COALESCE(w.`wins_json`, '{}'))),
  p.`latest_at`, p.`created_at`
FROM protocol_payloads p
LEFT JOIN win_payloads w
  ON w.`day` = p.`day` AND w.`pair_id` = p.`pair_id`
  AND w.`amount_id` = p.`amount_id` AND w.`mode` = p.`mode`;--> statement-breakpoint
DROP TABLE `daily_comparison_metrics`;--> statement-breakpoint
ALTER TABLE `__new_daily_comparison_metrics` RENAME TO `daily_comparison_metrics`;--> statement-breakpoint
CREATE INDEX `idx_daily_metrics_lookup` ON `daily_comparison_metrics` (`pair_id`,`amount_id`,`mode`,`day`);--> statement-breakpoint
CREATE INDEX `idx_daily_metrics_window` ON `daily_comparison_metrics` (`mode`,`day`);
