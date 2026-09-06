-- =====================================================================
-- Gated lives are discoverable as LOCKED cards, and freshness is decided
-- by the server's clock.
--
-- THE BUG. Session c5b7bb75 was live, with a heartbeat 90 seconds old,
-- and /discover?tab=live said "ยังไม่มีไลฟ์ตอนนี้". Nothing to do with the
-- heartbeat, the status or a cache: it was `access_level = 'subscribers'`.
-- `live_sessions_public_active_read` is
--
--     status IN ('live','waiting','scheduled','ended')
--     AND access_level = 'public'
--
-- so a gated session reads back as NO ROW to anyone without an
-- entitlement — metadata included. That is the documented platform rule
-- (publicFeed.ts:10-28) and it is right for a POST, which is still there
-- to be found tomorrow. It is wrong for a LIVE: a broadcast exists for an
-- hour, and nobody can subscribe to watch one they cannot see exists.
--
-- WHY AN RPC AND NOT A WIDER POLICY. `live_sessions` carries
-- `bunny_stream_key` — an RTMP ingest credential — and RLS is row-level,
-- so a read policy that let strangers see a gated row would hand them
-- that column too. This function is SECURITY DEFINER and returns a fixed
-- list of safe columns, so the exposure is exactly the lock card's
-- contents and nothing else.
--
-- SECOND FIX, IN THE SAME PLACE: the freshness cut is now made HERE,
-- against the database's clock. The client-side version shipped with the
-- watchdog compared `last_heartbeat_at` to `Date.now()`, which is the
-- VIEWER's clock — a desktop running two minutes fast would have judged
-- every live session stale and shown an empty live tab, indistinguishable
-- from the bug above. A server-side cut cannot skew.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The listing
-- ---------------------------------------------------------------------
--
-- `is_locked` is the whole point of the extra column: the caller renders a
-- card either way and paints a lock on the ones the viewer cannot open.
-- It reuses can_watch_live_session, so the badge and the actual gate at
-- /live/[id] cannot disagree — the lock card a viewer lands on after
-- tapping is decided by the same function that decided the badge.
--
-- STABLE, not VOLATILE: it only reads. That lets Postgres call it once per
-- statement and keeps it usable from a SELECT list.

CREATE OR REPLACE FUNCTION public.list_discoverable_live_sessions(p_limit INTEGER DEFAULT 8)
RETURNS TABLE (
  id UUID,
  creator_id UUID,
  room_name TEXT,
  title TEXT,
  current_viewer_count INTEGER,
  cover_image_url TEXT,
  access_level TEXT,
  is_locked BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT
    s.id,
    s.creator_id,
    s.room_name,
    s.title,
    s.current_viewer_count,
    s.cover_image_url,
    s.access_level,
    -- A PUBLIC live is never locked, even to a signed-out browser.
    -- can_watch_live_session answers false for a NULL user by design — every
    -- live requires a login to WATCH, which LiveWatchGuard enforces — but that
    -- is a different question from "is this gated". Asking it directly would
    -- paint a lock on every card in the live tab for every logged-out visitor,
    -- which is the opposite of discoverable.
    CASE
      WHEN s.access_level = 'public' THEN false
      ELSE NOT public.can_watch_live_session(s.id, auth.uid())
    END AS is_locked
  FROM public.live_sessions s
  WHERE s.status IN ('live', 'waiting')
    -- The freshness cut, on the server's clock. NULL is not stale: a row
    -- created before the heartbeat shipped, or one a second into go-live,
    -- has no evidence either way and the honest answer is "on air" — the
    -- same rule the watchdog applies when deciding whom to close.
    AND (
      s.last_heartbeat_at IS NULL
      OR s.last_heartbeat_at >
         now() - make_interval(secs => public.live_watchdog_grace_seconds())
    )
  ORDER BY s.current_viewer_count DESC, s.started_at DESC NULLS LAST
  -- Bounded here rather than trusted from the caller: this is reachable by
  -- anon, and an unbounded limit is an unbounded scan.
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 8), 1), 50);
$fn$;

REVOKE ALL ON FUNCTION public.list_discoverable_live_sessions(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_discoverable_live_sessions(INTEGER)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.list_discoverable_live_sessions(INTEGER) IS
  'Live and waiting sessions with a fresh heartbeat, INCLUDING gated ones, as safe columns plus is_locked. Bypasses RLS on purpose so a subscribers-only live can be discovered as a locked card; never returns bunny_stream_key or any other credential.';

-- ---------------------------------------------------------------------
-- 2. The server's clock, for a client that has to judge freshness itself
-- ---------------------------------------------------------------------
--
-- The live tab no longer needs this — section 1 does its cut server-side —
-- but /live/[sessionId] still does: it reads ONE row through RLS and has
-- to decide whether a session claiming to be live has gone quiet, so that
-- a viewer is not left on "กำลังเชื่อมต่อ…" for the minute it takes the
-- watchdog to write the row.
--
-- Doing that against `Date.now()` alone means a viewer whose device clock
-- is fast sees "ไลฟ์จบแล้ว" over a broadcast that is running, and unlike a
-- missing card that does not correct itself on the next poll — every poll
-- reaches the same wrong conclusion. One call to this on page load gives
-- the offset to correct by.

CREATE OR REPLACE FUNCTION public.server_now()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $fn$ SELECT now() $fn$;

REVOKE ALL ON FUNCTION public.server_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.server_now() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.server_now() IS
  'The database clock, for a client that must compare a stored timestamp against "now" without trusting the device clock.';
