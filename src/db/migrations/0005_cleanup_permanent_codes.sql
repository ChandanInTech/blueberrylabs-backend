-- Permanent access codes must never be pruned (architecture section 5).
--
-- `0003` deleted codes a week after expiry or redemption. Now that a code is a
-- user's permanent login, deleting it would lock that user out forever. Only
-- revoked codes are removable, and only after a grace period.

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

  -- Access codes are permanent credentials: only explicitly revoked ones are
  -- removed, and only after a week so the revocation can be audited.
  DELETE FROM access_codes
  WHERE revoked_at IS NOT NULL
    AND revoked_at < now() - interval '7 days';

  -- Only assets that were never referenced by a generation are removable.
  DELETE FROM assets
  WHERE upload_status <> 'UPLOADED'
    AND created_at < now() - make_interval(hours => p_pending_asset_ttl_hours)
    AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.input_asset_id = assets.id);
  GET DIAGNOSTICS v_assets = ROW_COUNT;

  RETURN QUERY SELECT v_rate, v_sessions, v_assets;
END;
$$;
