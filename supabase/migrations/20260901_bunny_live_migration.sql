-- Phase 2 — live streaming moves from LiveKit-to-every-viewer onto Bunny LL-HLS.
--
-- The shape that actually shipped is a hybrid, because Bunny Live has no WHIP
-- ingest (verified against library 740127 on 2026-09-01: a created live stream
-- answers with `ingestEndpoints: { rtmp: { ... } }` and nothing else). So the
-- creator still publishes WebRTC into a LiveKit room, a LiveKit RoomComposite
-- egress pushes that room to Bunny over RTMP, and every VIEWER leaves the
-- expensive path — they pull LL-HLS off the Bunny CDN instead of joining the
-- room. Viewer bandwidth is where all the money was, so the saving survives the
-- change of ingest.
--
-- Two consequences are encoded below:
--
--  1. A session now has TWO backend identities — a LiveKit room (publisher and
--     egress) and a Bunny live stream (transcode and delivery) — so the bunny_*
--     columns sit alongside room_name rather than replacing it. The livekit_*
--     columns stay for the same reason the brief asks: rows written before this
--     migration must keep meaning what they meant.
--
--  2. Chat and emoji reactions used to ride the LiveKit data channel, which
--     viewers no longer have. They move to a Supabase Realtime broadcast channel
--     named `live:<session_id>`, and that channel has to be gated by the same
--     rule as the playback URL — hence the realtime.messages policies at the
--     bottom, which are what makes it a PRIVATE channel rather than one any
--     signed-in user can read by guessing a session id.

-- ---------------------------------------------------------------------------
-- 1. Bunny live stream identity on live_sessions
-- ---------------------------------------------------------------------------

ALTER TABLE public.live_sessions
  ADD COLUMN IF NOT EXISTS bunny_stream_id TEXT,
  ADD COLUMN IF NOT EXISTS bunny_ingest_url TEXT,
  ADD COLUMN IF NOT EXISTS bunny_stream_key TEXT,
  ADD COLUMN IF NOT EXISTS bunny_playback_url TEXT,
  ADD COLUMN IF NOT EXISTS bunny_thumbnail_url TEXT,
  -- The id of the LiveKit egress pushing this room to Bunny. Needed to STOP it:
  -- an egress nobody stops keeps encoding, and encoding is the per-minute half
  -- of the bill.
  ADD COLUMN IF NOT EXISTS livekit_egress_id TEXT,
  ADD COLUMN IF NOT EXISTS latency_mode TEXT DEFAULT 'low_latency'
    CHECK (latency_mode IN ('ultra_low', 'low_latency', 'standard'));

-- SECURITY: bunny_stream_key is an ingest credential — anyone holding it can
-- publish into the creator's stream. It is written and read only by the service
-- role inside the live-* Edge Functions; no RLS policy on this table grants a
-- client SELECT on it, and nothing returns it to a viewer.
COMMENT ON COLUMN public.live_sessions.bunny_stream_key IS
  'Bunny RTMP ingest credential. Service-role only — never returned to a client.';

COMMENT ON COLUMN public.live_sessions.latency_mode IS
  'Player tuning for the LL-HLS viewer: ultra_low ~2s, low_latency ~3-5s, standard ~6s+ (the safe fallback when a stream stalls).';

-- Looking a session up by its Bunny stream id happens on the hot path of the
-- (future) Bunny live webhook, and only ever for a session still running.
CREATE INDEX IF NOT EXISTS idx_live_sessions_bunny_stream
  ON public.live_sessions(bunny_stream_id)
  WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Budget: Bunny live delivery is a third cost line
-- ---------------------------------------------------------------------------
--
-- livekit_cost_thb keeps its meaning but changes shape: it used to be
-- per-viewer WebRTC and is now a per-STREAM cost (one publisher plus one
-- egress), which is why the two lines are tracked apart. check-platform-budget
-- and live-end-session both write these.

ALTER TABLE public.platform_budget_state
  ADD COLUMN IF NOT EXISTS bunny_live_cost_thb NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.platform_budget_state.bunny_live_cost_thb IS
  'Bunny CDN delivery for live streams, THB. Scales with viewer-minutes; livekit_cost_thb now scales with stream-minutes only.';

-- ---------------------------------------------------------------------------
-- 3. Who may watch a live session
-- ---------------------------------------------------------------------------
--
-- One definition, two callers: the realtime.messages policies below and
-- live-get-playback-url. They were drifting apart in the LiveKit design (the
-- join function had its own copy of the entitlement ladder) and drift here
-- means the chat channel and the video disagree about who is allowed in.
--
-- SECURITY DEFINER because a viewer cannot read a locked live_sessions row —
-- that is the whole reason the check has to happen above RLS.
--
-- 'ppv' deliberately returns false: no live PPV unlock path exists yet, and the
-- LiveKit join function refused those sessions too. Preserving that here keeps
-- this migration a transport change and not an entitlement change.

CREATE OR REPLACE FUNCTION public.can_watch_live_session(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_session public.live_sessions;
  v_creator_user_id UUID;
BEGIN
  IF p_session_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO v_session FROM public.live_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- A finished broadcast has nothing to join and no channel to talk on.
  IF v_session.ended_at IS NOT NULL OR v_session.status IN ('ended', 'cancelled') THEN
    RETURN false;
  END IF;

  SELECT user_id INTO v_creator_user_id
  FROM public.creators
  WHERE id = v_session.creator_id;

  -- The broadcaster is always allowed into their own session, whatever it is
  -- locked to — they are the one publishing it.
  IF v_creator_user_id IS NOT NULL AND v_creator_user_id = p_user_id THEN
    RETURN true;
  END IF;

  IF v_session.access_level = 'public' THEN
    RETURN true;
  END IF;

  IF v_session.access_level = 'subscribers' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.subscriptions s
      WHERE s.creator_id = v_session.creator_id
        AND s.subscriber_id = p_user_id
        AND s.status = 'active'
        AND s.expires_at > now()
    );
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.can_watch_live_session(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_watch_live_session(UUID, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The `live:<session_id>` Realtime channel
-- ---------------------------------------------------------------------------
--
-- Reactions and chat are broadcast-only: nothing is written to Postgres
-- (unchanged from the LiveKit design — chat is ephemeral by decision, not by
-- accident). What IS new is that the channel is opened as `private: true`, so
-- Realtime authorises every subscribe and every send against the policies
-- below instead of letting any signed-in client join by guessing a UUID.

-- Parses a topic name into a session id, or NULL when the topic is not one of
-- ours. Written as a strict regex rather than a cast so that a topic like
-- `live:` or `live:hello` returns NULL instead of raising 22P02 inside a policy,
-- which would surface as an authorisation error on unrelated channels.
CREATE OR REPLACE FUNCTION public.live_session_id_from_topic(p_topic TEXT)
RETURNS UUID
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_topic ~ '^live:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN substring(p_topic FROM 6)::uuid
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.live_session_id_from_topic(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.live_session_id_from_topic(TEXT) TO authenticated, service_role;

-- Receiving. SELECT on realtime.messages is what Realtime checks when a client
-- subscribes to a private channel.
DROP POLICY IF EXISTS "live_channel_receive" ON realtime.messages;
CREATE POLICY "live_channel_receive"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    public.can_watch_live_session(
      public.live_session_id_from_topic(realtime.topic()),
      (SELECT auth.uid())
    )
  );

-- Sending. Same rule on purpose: anyone entitled to watch may react and chat,
-- and nobody else can put a message on the channel at all.
DROP POLICY IF EXISTS "live_channel_send" ON realtime.messages;
CREATE POLICY "live_channel_send"
  ON realtime.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_watch_live_session(
      public.live_session_id_from_topic(realtime.topic()),
      (SELECT auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 5. The broadcaster writes the audience size
-- ---------------------------------------------------------------------------
--
-- Counting viewers got harder and then easier. Under LiveKit the broadcaster
-- could just ask the room. Under LL-HLS a viewer is an HTTP request to a CDN
-- and there is no room to ask — so the count now comes from Realtime PRESENCE
-- on the `live:<session_id>` channel, which every viewer is already subscribed
-- to for chat and reactions, and which drops a viewer automatically when their
-- socket closes. That is a better number than the LiveKit one was: it clears
-- itself, where current_viewer_count previously only ever climbed.
--
-- This RPC is how that number is written. It exists rather than a plain UPDATE
-- because the peak has to be raised with GREATEST server-side: two writes in
-- flight at once (the broadcaster's timer and its new-peak write) could
-- otherwise walk the maximum backwards, and live-end-session reads that peak
-- to build the session summary and the bill.

CREATE OR REPLACE FUNCTION public.set_live_viewer_counts(
  p_session_id UUID,
  p_current INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_owner UUID;
BEGIN
  -- Only the broadcaster may write their own audience size. Without this an
  -- authenticated stranger could set any creator's viewer count to anything,
  -- which lands on the discover card AND in the cost estimate.
  SELECT c.user_id INTO v_owner
  FROM public.live_sessions s
  JOIN public.creators c ON c.id = s.creator_id
  WHERE s.id = p_session_id;

  IF v_owner IS NULL OR v_owner <> auth.uid() THEN
    RETURN;
  END IF;

  UPDATE public.live_sessions
  SET current_viewer_count = GREATEST(0, p_current),
      peak_viewer_count = GREATEST(peak_viewer_count, GREATEST(0, p_current)),
      updated_at = now()
  WHERE id = p_session_id
    AND status IN ('waiting', 'live');
END;
$$;

REVOKE ALL ON FUNCTION public.set_live_viewer_counts(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_live_viewer_counts(UUID, INTEGER) TO authenticated, service_role;
