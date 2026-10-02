UPDATE `daily_comparison_metrics`
SET `metrics_json` = json_set(
  `metrics_json`,
  '$.p.thorchain[5]',
  CASE
    WHEN `pair_id` LIKE '%zcash:native:zec%' THEN 0
    ELSE COALESCE(json_extract(`metrics_json`, '$.p.thorchain[0]'), 0)
  END
)
WHERE json_type(`metrics_json`, '$.p.thorchain[5]') IS NULL;--> statement-breakpoint
UPDATE `daily_comparison_metrics`
SET `metrics_json` = json_set(
  `metrics_json`,
  '$.p.maya[5]',
  CASE WHEN `pair_id` IN (
    'bitcoin:native:btc__ethereum:native:eth',
    'ethereum:native:eth__bitcoin:native:btc',
    'bitcoin:native:btc__ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__bitcoin:native:btc',
    'bitcoin:native:btc__ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7',
    'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7__bitcoin:native:btc',
    'ethereum:native:eth__ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__ethereum:native:eth',
    'ethereum:native:eth__ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7',
    'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7__ethereum:native:eth',
    'zcash:native:zec__bitcoin:native:btc',
    'bitcoin:native:btc__zcash:native:zec',
    'zcash:native:zec__ethereum:native:eth',
    'ethereum:native:eth__zcash:native:zec',
    'zcash:native:zec__ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__zcash:native:zec'
  ) THEN COALESCE(json_extract(`metrics_json`, '$.p.maya[0]'), 0) ELSE 0 END
)
WHERE json_type(`metrics_json`, '$.p.maya[5]') IS NULL;--> statement-breakpoint
UPDATE `daily_comparison_metrics`
SET `metrics_json` = json_set(
  `metrics_json`,
  '$.p.chainflip[5]',
  CASE WHEN `pair_id` IN (
    'bitcoin:native:btc__ethereum:native:eth',
    'ethereum:native:eth__bitcoin:native:btc',
    'bitcoin:native:btc__ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__bitcoin:native:btc',
    'bitcoin:native:btc__tron:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t',
    'tron:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t__bitcoin:native:btc',
    'bitcoin:native:btc__ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7',
    'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7__bitcoin:native:btc',
    'ethereum:native:eth__ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__ethereum:native:eth',
    'ethereum:native:eth__tron:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t',
    'tron:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t__ethereum:native:eth',
    'ethereum:native:eth__ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7',
    'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7__ethereum:native:eth',
    'bitcoin:native:btc__sol:native:sol',
    'sol:native:sol__bitcoin:native:btc',
    'bitcoin:native:btc__tron:native:trx',
    'tron:native:trx__bitcoin:native:btc',
    'sol:native:sol__ethereum:native:eth',
    'ethereum:native:eth__sol:native:sol',
    'sol:native:sol__ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__sol:native:sol'
  ) THEN COALESCE(json_extract(`metrics_json`, '$.p.chainflip[0]'), 0) ELSE 0 END
)
WHERE json_type(`metrics_json`, '$.p.chainflip[5]') IS NULL;--> statement-breakpoint
UPDATE `daily_comparison_metrics`
SET `metrics_json` = json_set(
  `metrics_json`,
  '$.p."near-intents"[5]',
  COALESCE(json_extract(`metrics_json`, '$.p."near-intents"[0]'), 0)
)
WHERE json_type(`metrics_json`, '$.p."near-intents"[5]') IS NULL;
