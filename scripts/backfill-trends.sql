-- Rebuild the rolling graph inputs from detailed quote history already in D1.
-- This is idempotent because each bucket has a deterministic primary key.

INSERT OR REPLACE INTO trend_buckets (
  id, bucket_start, bucket_seconds, pair_id, amount_id, mode,
  samples_json, latest_at
)
WITH bucketed_runs AS (
  SELECT r.id, r.pair_id, r.amount_id, r.mode, r.initiated_at,
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      CAST(unixepoch(r.initiated_at) / 3600 AS INTEGER) * 3600,
      'unixepoch'
    ) AS bucket_start
  FROM benchmark_runs r
  WHERE unixepoch(r.initiated_at) >= unixepoch('now', '-8 days')
)
SELECT
  CAST(3600 AS TEXT) || '|' || bucket_start || '|' || pair_id || '|' || amount_id || '|' || mode,
  bucket_start,
  3600,
  pair_id,
  amount_id,
  mode,
  json_group_array(json_object(
    'runId', id,
    'initiatedAt', initiated_at,
    'quotes', json(COALESCE((
      SELECT json_group_array(json_object(
        'protocol', q.protocol,
        'output', CAST(q.expected_output_formatted AS REAL)
      ))
      FROM protocol_quotes q
      WHERE q.run_id = bucketed_runs.id
        AND q.status = 'quoted'
        AND CAST(q.expected_output_formatted AS REAL) > 0
    ), '[]'))
  )),
  MAX(initiated_at)
FROM bucketed_runs
GROUP BY bucket_start, pair_id, amount_id, mode;

INSERT OR REPLACE INTO trend_buckets (
  id, bucket_start, bucket_seconds, pair_id, amount_id, mode,
  samples_json, latest_at
)
WITH bucketed_runs AS (
  SELECT r.id, r.pair_id, r.amount_id, r.mode, r.initiated_at,
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      CAST(unixepoch(r.initiated_at) / 14400 AS INTEGER) * 14400,
      'unixepoch'
    ) AS bucket_start
  FROM benchmark_runs r
  WHERE unixepoch(r.initiated_at) >= unixepoch('now', '-32 days')
)
SELECT
  CAST(14400 AS TEXT) || '|' || bucket_start || '|' || pair_id || '|' || amount_id || '|' || mode,
  bucket_start,
  14400,
  pair_id,
  amount_id,
  mode,
  json_group_array(json_object(
    'runId', id,
    'initiatedAt', initiated_at,
    'quotes', json(COALESCE((
      SELECT json_group_array(json_object(
        'protocol', q.protocol,
        'output', CAST(q.expected_output_formatted AS REAL)
      ))
      FROM protocol_quotes q
      WHERE q.run_id = bucketed_runs.id
        AND q.status = 'quoted'
        AND CAST(q.expected_output_formatted AS REAL) > 0
    ), '[]'))
  )),
  MAX(initiated_at)
FROM bucketed_runs
GROUP BY bucket_start, pair_id, amount_id, mode;
