-- Atomic fixed-window rate limiting (architecture section 13.2).
-- One statement per decision: no read-then-write race, correct under
-- concurrent API instances, and the window grid is shared by all callers.

CREATE OR REPLACE FUNCTION consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE (allowed boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_window_start timestamptz;
  v_reset timestamptz;
  v_count integer;
BEGIN
  v_window_start := to_timestamp(floor(extract(epoch FROM v_now) / p_window_seconds) * p_window_seconds);
  v_reset := v_window_start + make_interval(secs => p_window_seconds);

  INSERT INTO rate_limit_buckets (key, window_start, request_count, expires_at)
  VALUES (p_key, v_window_start, 1, v_reset + interval '60 seconds')
  ON CONFLICT (key) DO UPDATE
  SET
    request_count = CASE
      WHEN rate_limit_buckets.window_start = EXCLUDED.window_start
        THEN rate_limit_buckets.request_count + 1
      ELSE 1
    END,
    window_start = EXCLUDED.window_start,
    expires_at = CASE
      WHEN rate_limit_buckets.window_start = EXCLUDED.window_start
        THEN rate_limit_buckets.expires_at
      ELSE EXCLUDED.expires_at
    END
  RETURNING rate_limit_buckets.request_count INTO v_count;

  RETURN QUERY SELECT
    v_count <= p_limit,
    GREATEST(p_limit - v_count, 0),
    v_reset;
END;
$$;

-- Retention policy (architecture section 8.8): expired rate-limit rows,
-- old sessions, and abandoned pending uploads.
CREATE OR REPLACE FUNCTION cleanup_expired_rows(p_pending_asset_ttl_hours integer DEFAULT 24)
RETURNS TABLE (rate_limits_deleted integer, sessions_deleted integer, pending_assets_deleted integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_rate integer;
  v_sessions integer;
  v_assets integer;
BEGIN
  DELETE FROM rate_limit_buckets WHERE expires_at < now();
  GET DIAGNOSTICS v_rate = ROW_COUNT;

  DELETE FROM demo_sessions
  WHERE expires_at < now() - interval '7 days'
     OR revoked_at < now() - interval '7 days';
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  -- Only assets that were never referenced by a generation are removable.
  DELETE FROM assets
  WHERE upload_status <> 'UPLOADED'
    AND created_at < now() - make_interval(hours => p_pending_asset_ttl_hours)
    AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.input_asset_id = assets.id);
  GET DIAGNOSTICS v_assets = ROW_COUNT;

  RETURN QUERY SELECT v_rate, v_sessions, v_assets;
END;
$$;
