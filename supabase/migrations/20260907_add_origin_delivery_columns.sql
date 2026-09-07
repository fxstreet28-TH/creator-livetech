-- =============================================================================
-- Origin delivery — self-hosted MediaMTX + Caddy as a third delivery pipeline.
-- =============================================================================
--
-- WHAT THIS ADDS. A live session can now be carried by one of THREE pipelines,
-- chosen at create time by the `live_delivery_mode` vault secret:
--
--   livekit  creator publishes WebRTC to LiveKit; viewers subscribe to the same
--            room over WebRTC. Sub-second, and ~8x dearer per viewer.
--   llhls    creator publishes WebRTC to LiveKit; a RoomComposite egress pushes
--            RTMP to Bunny Live, which produces LL-HLS for the CDN.
--   origin   NEW. Creator publishes WHIP (WebRTC) straight to our own MediaMTX
--            on origin-sg-1, which produces LL-HLS itself; a Bunny Standard
--            Pull Zone caches and delivers it. No LiveKit and no Bunny Live in
--            the path at all, which is the point: no per-participant-minute
--            bill, and no vendor between the camera and the playlist.
--
-- The three columns below are the origin path's half of the row. They are all
-- nullable and all default NULL, so every existing session and both existing
-- pipelines are untouched — a livekit or llhls row simply never sets them.
--
-- WHY THE ROW STORES THE URLS RATHER THAN REBUILDING THEM. The vault holds the
-- BASE of each endpoint, not the per-session URL, and the bases are expected to
-- move (a second origin box, a different pull zone hostname). A session that
-- rebuilt its URLs from the current base every time it was read would silently
-- re-point a broadcast that is already on air at a host that is not carrying
-- it. Resolved once at create and stored, so a session keeps the endpoints it
-- was actually opened against.

-- -----------------------------------------------------------------------------
-- 1. The origin columns
-- -----------------------------------------------------------------------------

ALTER TABLE public.live_sessions
  ADD COLUMN IF NOT EXISTS origin_room_id text,
  ADD COLUMN IF NOT EXISTS whip_publish_url text,
  ADD COLUMN IF NOT EXISTS hls_playback_url text;

COMMENT ON COLUMN public.live_sessions.origin_room_id IS
  'MediaMTX path segment when delivery=origin (live/<origin_room_id>). NULL for livekit and llhls sessions.';
COMMENT ON COLUMN public.live_sessions.whip_publish_url IS
  'WHIP ingest endpoint the creator publishes to (origin mode only). Not a credential: entitlement to publish is the creator auth on live-create-session, not knowledge of this URL.';
COMMENT ON COLUMN public.live_sessions.hls_playback_url IS
  'LL-HLS playlist URL via the Bunny pull zone (origin mode only). Handed to viewers by live-get-playback-url after the entitlement check.';

-- UNIQUE rather than the plain index the deploy plan called for.
--
-- origin_room_id is the MediaMTX path two broadcasts would COLLIDE on: the
-- second publisher to a path either takes it over or is refused, depending on
-- `disablePublisherOverride`, and both outcomes are a creator broadcasting into
-- someone else's session. The id is minted as <session_id>-<8 random chars> so
-- a collision should be impossible — this is the constraint that makes "should
-- be" into "is", at the cost of one index that a plain one was paying anyway.
CREATE UNIQUE INDEX IF NOT EXISTS idx_live_sessions_origin_room_id
  ON public.live_sessions(origin_room_id)
  WHERE origin_room_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. The concurrent-broadcast cap
-- -----------------------------------------------------------------------------
--
-- origin-sg-1 is 2 vCPU / 4 GB carrying every broadcast on one box, so unlike
-- LiveKit and Bunny it has a hard ceiling: ~15 concurrent LL-HLS remuxes before
-- it degrades everyone at once. `origin_concurrent_live_cap` (vault, 12) is the
-- number live-create-session refuses at, 20% under that ceiling.
--
-- WHY THIS IS A FUNCTION AND NOT A COUNT IN THE EDGE FUNCTION. "How many
-- sessions are occupying a slot right now" is not `status = 'live'`, and the
-- two ways of getting it wrong fail in opposite directions:
--
--   Counting 'live' alone UNDERCOUNTS. A session is inserted 'waiting' and is
--   only promoted to 'live' by its first heartbeat (touch_live_heartbeat, 20s
--   cadence). Between those two moments the creator is publishing to MediaMTX
--   and holding a real slot while counting as zero — so at the cap boundary
--   more broadcasts are admitted than the box can carry.
--
--   Counting 'waiting' too OVERCOUNTS. A creator who opens the form and closes
--   the tab leaves a 'waiting' row with a NULL heartbeat that nothing ever
--   closes — the watchdog deliberately skips rows that never beat, since there
--   is no evidence anyone went on air. Counted naively, abandoned rows would
--   accumulate until go-live is permanently refused for everybody.
--
-- So a slot is held by a session that is open AND recently alive: it has beaten
-- inside the grace period, or it is new enough that its first beat is not yet
-- due. Same grace as the watchdog, read from the same function, so a session
-- stops holding a slot at the same moment the watchdog becomes willing to close
-- it and the two can never disagree.
CREATE OR REPLACE FUNCTION public.count_active_live_sessions()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
    FROM public.live_sessions
   WHERE status IN ('live', 'waiting')
     AND ended_at IS NULL
     AND (
       last_heartbeat_at > now() - make_interval(secs => public.live_watchdog_grace_seconds())
       OR (
         last_heartbeat_at IS NULL
         AND started_at > now() - make_interval(secs => public.live_watchdog_grace_seconds())
       )
     );
$$;

COMMENT ON FUNCTION public.count_active_live_sessions() IS
  'Broadcasts currently holding an origin capacity slot: open, and either beating inside the watchdog grace period or too new to have beaten yet. Read by live-create-session to enforce origin_concurrent_live_cap.';

-- service_role only. This is a capacity number for the admission check inside
-- an Edge Function, not something a client needs — and a creator who could read
-- it could map how busy the platform is, which is nobody's business but ours.
REVOKE ALL ON FUNCTION public.count_active_live_sessions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_active_live_sessions() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_active_live_sessions() TO service_role;
