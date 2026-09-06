-- =====================================================================
-- Live session watchdog — stop broadcasts from staying 'live' forever.
--
-- THE BUG. `live_sessions.status` only ever became 'ended' because a
-- creator pressed "จบไลฟ์" and live-end-session ran. Close the tab, shut
-- the laptop, lose signal on a train, and the row stayed 'live': the
-- session held its slot in "🔴 กำลังไลฟ์ตอนนี้", every viewer who opened
-- it sat on "กำลังเชื่อมต่อ…" forever, and the LiveKit RoomComposite
-- egress kept running and kept billing. Two sessions were found open for
-- 16h and 0.8h and ended by hand in SQL. publicFeed.ts has carried a
-- TODO about this since the LL-HLS migration; this is that reaper.
--
-- THE SHAPE OF THE FIX, in three pieces that each fail safe:
--
--   1. The studio writes a heartbeat every 20s (touch_live_heartbeat).
--   2. pg_cron runs run_live_watchdog() every minute. It POSTs to the
--      live-watchdog Edge Function, which stops the stream at LiveKit and
--      Bunny and closes the row down the SAME code path "จบไลฟ์" uses.
--   3. If that HTTP hop is broken — no Vault secret, function undeployed,
--      pg_net stuck — a session more than LONG_ABANDON old is closed in
--      SQL anyway, loudly. See close_long_abandoned_live_sessions().
--
-- Piece 3 exists because the failure being fixed is "a row nobody ever
-- closes". A watchdog whose only path to closing a row is an HTTP call
-- reproduces that bug exactly whenever the call is broken, and does it
-- silently. It cannot stop the provider — that is why it is a last
-- resort and not the design — so it says so on the row and in the log.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------
-- 1. The heartbeat column
-- ---------------------------------------------------------------------

ALTER TABLE public.live_sessions
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

COMMENT ON COLUMN public.live_sessions.last_heartbeat_at IS
  'Last time the broadcasting studio said it was still on air (every 20s). NULL means no studio ever reported for this row — the watchdog leaves those alone. Stale by more than the grace period means the broadcaster is gone.';

-- The watchdog's only query: open sessions ordered by how long since they
-- were last heard from. Partial, because the rows it must never scan are
-- the overwhelming majority — every session that has already ended.
CREATE INDEX IF NOT EXISTS idx_live_sessions_heartbeat_open
  ON public.live_sessions(last_heartbeat_at)
  WHERE status IN ('live', 'waiting');

-- Sessions that are open RIGHT NOW get a heartbeat of `now()`, not of
-- their start: this migration must not close a broadcast that is genuinely
-- on air the minute it lands. A creator who really has gone will simply
-- stop refreshing it and be reaped 90 seconds later, which is the
-- behaviour every subsequent session gets anyway.
UPDATE public.live_sessions
   SET last_heartbeat_at = now()
 WHERE status IN ('live', 'waiting')
   AND last_heartbeat_at IS NULL;

-- ---------------------------------------------------------------------
-- 2. The grace period, in one place
-- ---------------------------------------------------------------------
--
-- Read by both SQL functions below. The Edge Function restates it as a
-- constant (GRACE_SECONDS) because it is on the hot path of every run and
-- a round trip to agree on a number is not worth it — the two must be
-- changed together, and both say so.
--
-- 90 seconds is four missed 20s beats: long enough to ride out a phone
-- changing cell or a laptop briefly sleeping, short enough that "kill the
-- tab, the session closes within two minutes" holds against a cron that
-- ticks once a minute.

CREATE OR REPLACE FUNCTION public.live_watchdog_grace_seconds()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $fn$ SELECT 90 $fn$;

-- ---------------------------------------------------------------------
-- 3. The heartbeat write
-- ---------------------------------------------------------------------
--
-- Modelled on set_live_viewer_counts, and for the same reason: the
-- broadcaster is an ordinary authenticated user, so the write has to go
-- through a SECURITY DEFINER function that checks they own the session
-- rather than through a table grant. Without that check any signed-in
-- stranger could keep any creator's session alive indefinitely — which
-- would defeat the entire watchdog.
--
-- It also PROMOTES 'waiting' to 'live'. markSessionLive on the client is
-- best-effort and its UPDATE is sometimes refused, which is why
-- fetchLiveSessions has to treat 'waiting' as on-air; a heartbeat is
-- unambiguous evidence that a studio is broadcasting, so the row is
-- corrected here where the evidence arrives.

CREATE OR REPLACE FUNCTION public.touch_live_heartbeat(p_session_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_owner UUID;
  v_now   TIMESTAMPTZ := now();
BEGIN
  SELECT c.user_id INTO v_owner
  FROM public.live_sessions s
  JOIN public.creators c ON c.id = s.creator_id
  WHERE s.id = p_session_id;

  -- IS DISTINCT FROM, not <>. `v_owner <> auth.uid()` evaluates to NULL when
  -- auth.uid() is NULL, `FALSE OR NULL` is NULL, and `IF NULL THEN` does not
  -- fire — so a caller with no `sub` claim FELL THROUGH THIS GUARD and got the
  -- write. Caught in QA: a heartbeat written from an unauthenticated session.
  -- `IS DISTINCT FROM` is NULL-safe and answers TRUE there, which refuses.
  --
  -- set_live_viewer_counts (20260901) has the same `<>` shape and the same
  -- hole; it is left alone here because it is outside this change, but it
  -- should get the same fix.
  IF v_owner IS NULL OR v_owner IS DISTINCT FROM auth.uid() THEN
    RETURN NULL;
  END IF;

  UPDATE public.live_sessions
     SET last_heartbeat_at = v_now,
         status = CASE WHEN status = 'waiting' THEN 'live' ELSE status END,
         started_at = COALESCE(started_at, v_now),
         updated_at = v_now
   WHERE id = p_session_id
     AND status IN ('waiting', 'live');

  -- NULL when the session had already ended: the studio reads that as
  -- "stop beating", which is what stops a restored background tab from
  -- resurrecting a session the watchdog just closed.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN v_now;
END;
$fn$;

REVOKE ALL ON FUNCTION public.touch_live_heartbeat(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_live_heartbeat(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.touch_live_heartbeat(UUID) IS
  'The broadcasting studio says it is still on air. Returns the new heartbeat, or NULL when the caller does not own the session or it has already ended.';

-- ---------------------------------------------------------------------
-- 4. The last resort: close a long-abandoned session in SQL
-- ---------------------------------------------------------------------
--
-- Twenty minutes, against the watchdog's ninety seconds. The gap is
-- deliberate: this must only ever fire when the Edge Function path has
-- been failing for many consecutive minutes, so that in normal operation
-- it never runs at all and the provider is always stopped properly.
--
-- IT CANNOT STOP THE EGRESS. Postgres has no way to call LiveKit. So it
-- does the half it can — take the row off the dashboard and out of every
-- viewer's spinner — and records on the row and in the log that the
-- provider was NOT stopped, because an egress still running is a bill
-- still growing and somebody has to know to go and look.

CREATE OR REPLACE FUNCTION public.close_long_abandoned_live_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_closed INTEGER := 0;
  v_row    RECORD;
BEGIN
  FOR v_row IN
    SELECT id, last_heartbeat_at, started_at
      FROM public.live_sessions
     WHERE status IN ('live', 'waiting')
       AND last_heartbeat_at IS NOT NULL
       AND last_heartbeat_at < now() - INTERVAL '20 minutes'
     ORDER BY last_heartbeat_at
     LIMIT 50
  LOOP
    UPDATE public.live_sessions
       SET status = 'ended',
           ended_at = v_row.last_heartbeat_at,
           duration_seconds = GREATEST(
             0,
             EXTRACT(EPOCH FROM (
               v_row.last_heartbeat_at - COALESCE(v_row.started_at, v_row.last_heartbeat_at)
             ))::INTEGER
           ),
           current_viewer_count = 0,
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'closed_by', 'sql_fallback',
             'watchdog', jsonb_build_object(
               'closed_at', now(),
               'provider_stop', 'not_attempted',
               'reason', 'live-watchdog Edge Function did not close this session within 20 minutes'
             )
           )
     WHERE id = v_row.id
       AND status IN ('live', 'waiting');

    v_closed := v_closed + 1;

    -- Loud on purpose. Reaching this line means the Edge Function path is
    -- broken and a LiveKit egress may still be billing.
    RAISE WARNING 'live watchdog: closed session % in SQL after 20 min — the provider stream was NOT stopped, check live-watchdog', v_row.id;
  END LOOP;

  RETURN v_closed;
END;
$fn$;

REVOKE ALL ON FUNCTION public.close_long_abandoned_live_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_long_abandoned_live_sessions() TO service_role;

-- ---------------------------------------------------------------------
-- 5. The cron entry point
-- ---------------------------------------------------------------------
--
-- Same pg_net + Vault pattern as notify_email_event (20260829): the URL
-- and the service key are Vault secrets, not GUCs, so neither is in a
-- pg_dump and neither is in this file. The two names are
--   edge_function_live_watchdog_url   this function's https URL
--   edge_function_service_key         the project service role key (shared)
--
-- The 20260826 migration argued against pg_net for the star expiry job and
-- called run_star_expiration_cycle() directly instead. That reasoning does
-- not transfer: star expiry is pure SQL, and this is not — stopping a
-- LiveKit egress is an authenticated HTTP call to a third party, so the
-- hop has to exist. What that migration was right about is the risk, and
-- section 4 is the answer to it.
--
-- It returns early when nothing is stale, so the ordinary minute costs one
-- indexed count and no HTTP at all.

CREATE OR REPLACE FUNCTION public.run_live_watchdog()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_stale       INTEGER;
  v_edge_url    TEXT;
  v_service_key TEXT;
BEGIN
  SELECT count(*) INTO v_stale
    FROM public.live_sessions
   WHERE status IN ('live', 'waiting')
     AND last_heartbeat_at IS NOT NULL
     AND last_heartbeat_at < now() - make_interval(secs => public.live_watchdog_grace_seconds());

  IF v_stale = 0 THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_edge_url
    FROM vault.decrypted_secrets WHERE name = 'edge_function_live_watchdog_url';
  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets WHERE name = 'edge_function_service_key';

  IF v_edge_url IS NULL OR v_service_key IS NULL THEN
    RAISE WARNING 'live watchdog: vault secrets missing, % stale session(s) not closed', v_stale;
  ELSE
    -- Queued now, dispatched by the pg_net worker after this transaction
    -- commits. The function re-reads the rows itself, so it never acts on
    -- a list that went stale between here and there.
    PERFORM net.http_post(
      url     := v_edge_url,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_key
      ),
      body    := jsonb_build_object('triggered_by', 'pg_cron', 'stale_count', v_stale)
    );
  END IF;

  -- Always, and after the POST: it only acts on sessions the HTTP path has
  -- already had twenty minutes to deal with.
  PERFORM public.close_long_abandoned_live_sessions();
END;
$fn$;

REVOKE ALL ON FUNCTION public.run_live_watchdog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_live_watchdog() TO service_role;

-- ---------------------------------------------------------------------
-- 6. The schedule
-- ---------------------------------------------------------------------
--
-- Every minute. With a 90s grace that puts the worst case at 150s from
-- the last heartbeat to the row being closed, which is the two-minute QA
-- target for the common case (a beat lands mid-minute) and a little over
-- it for the worst one.

SELECT cron.unschedule('live-session-watchdog')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'live-session-watchdog');

SELECT cron.schedule(
    'live-session-watchdog',
    '* * * * *',
    $job$SELECT public.run_live_watchdog();$job$
);
