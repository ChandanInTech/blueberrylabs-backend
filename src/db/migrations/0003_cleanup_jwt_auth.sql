-- Extend the retention sweep to the JWT auth tables (architecture section 8.8).
--
-- `0001` already shipped, so this is a new migration rather than an edit: the
-- migrator tracks applied files by journal timestamp and would never re-run a
-- modified `0001`.

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

  -- Legacy cookie sessions (kept until the table is dropped).
  DELETE FROM demo_sessions
  WHERE expires_at < now() - interval '7 days'
     OR revoked_at < now() - interval '7 days';

  -- JWT sessions: the row is the revocation record, so it must outlive the
  -- token by a margin. A week past expiry is enough to answer "was this token
  -- revoked?" for any token a client could still be holding.
  DELETE FROM auth_sessions
  WHERE expires_at < now() - interval '7 days'
     OR revoked_at < now() - interval '7 days';
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  -- Redeemed or expired access codes are dead weight; keep them briefly for
  -- audit, then drop them.
  DELETE FROM access_codes
  WHERE expires_at < now() - interval '7 days'
     OR redeemed_at < now() - interval '7 days'
     OR revoked_at < now() - interval '7 days';

  -- Only assets that were never referenced by a generation are removable.
  DELETE FROM assets
  WHERE upload_status <> 'UPLOADED'
    AND created_at < now() - make_interval(hours => p_pending_asset_ttl_hours)
    AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.input_asset_id = assets.id);
  GET DIAGNOSTICS v_assets = ROW_COUNT;

  RETURN QUERY SELECT v_rate, v_sessions, v_assets;
END;
$$;
