-- =====================================================================
-- live_viewer_diagnostics: what the self-healing viewer actually did.
--
-- WHY THIS TABLE EXISTS. A viewer's phone failed to play a live today and
-- a reboot fixed it. That is the only fact anybody has, and it is not
-- enough to fix anything: nobody knows whether the connect never
-- completed, the decoder wedged mid-stream, or the phone was running a
-- bundle from three deploys ago. The recovery ladder now tries four
-- increasingly violent things on its own, and this is where it records
-- which rung the viewer was on and whether that rung worked — so the
-- NEXT time this happens the answer is a query, not a reboot.
--
-- The point of the data is the pairing: a row for entering a step and a
-- row for its outcome. "relay fixed 40 of 44 iPhones and none of the
-- Androids" is an actionable sentence; "playback failed" is not.
--
-- WHO CAN WRITE. Anyone watching, including a logged-out viewer — a
-- broadcast can be public, and the devices most likely to break are the
-- ones least likely to be signed in. That makes this an insert endpoint
-- reachable by the internet, so it is a SECURITY DEFINER function rather
-- than an INSERT policy, and it is narrow on purpose:
--
--   * the caller chooses NOTHING that is not in the argument list — no
--     id, no created_at, no user_id (taken from auth.uid(), which is
--     NULL for a guest and cannot be spoofed),
--   * `step` and `outcome` are checked against fixed vocabularies, so
--     the column cannot become a free-text field someone stuffs,
--   * every text input is length-capped and `detail` is capped as a
--     whole, so a row cannot be used as free storage,
--   * the session must EXIST and have been created in the last day,
--     which keeps the table tied to real broadcasts.
--
-- It is still an unauthenticated write and it is worth saying so plainly:
-- someone determined can put junk rows against a live session id they
-- know. The mitigation is that the rows are cheap, bounded, and
-- attributable to a client_id, and that this is diagnostics rather than
-- anything the product reads back. Nothing here is shown to a viewer and
-- nothing here is billed on.
--
-- WHO CAN READ. Nobody, through the API. No SELECT policy is created, so
-- RLS denies every read from anon and authenticated; the service role
-- bypasses RLS for the queries this exists to answer. A viewer's
-- user-agent and failure history is not something another viewer — or
-- the creator — has any reason to page through.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.live_viewer_diagnostics (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.live_sessions(id) ON DELETE CASCADE,
  -- NULL for a logged-out viewer, which is normal and not an error.
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- One per tab, generated client-side. This is what turns a pile of rows
  -- into a story: the ladder for ONE viewer, in order.
  client_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Which rung, and what happened on it.
  step TEXT NOT NULL,
  outcome TEXT NOT NULL,
  -- 'hls' or 'livekit'. The two paths fail differently and the ladder
  -- does different things on each, so a row without this is unreadable.
  delivery TEXT NOT NULL,
  -- How many times the ladder has escalated during THIS watch.
  attempt INTEGER NOT NULL DEFAULT 0,
  -- Milliseconds from the start of the current unhealthy stretch. What
  -- makes "the ladder is too slow" or "8s was too eager" answerable.
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  -- The bundle the viewer was RUNNING, which is the whole point of the
  -- stale-build guard: a device stuck on an old build is invisible
  -- otherwise.
  build_id TEXT,
  user_agent TEXT,
  -- Anything step-specific: an hls.js error detail, a video error code,
  -- a readyState. Capped in the function.
  detail JSONB
);

-- The two queries this table exists for: "what happened to this
-- broadcast" and "which step fixes which device, lately".
CREATE INDEX IF NOT EXISTS live_viewer_diagnostics_session_idx
  ON public.live_viewer_diagnostics (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_viewer_diagnostics_recent_idx
  ON public.live_viewer_diagnostics (created_at DESC);

ALTER TABLE public.live_viewer_diagnostics ENABLE ROW LEVEL SECURITY;

-- Deliberately no policies. RLS with no policy denies everything, which
-- is the intent: writes go through the function below, reads go through
-- the service role. See the header.

-- ---------------------------------------------------------------------
-- The write path
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_live_viewer_diagnostic(
  p_session_id UUID,
  p_client_id TEXT,
  p_step TEXT,
  p_outcome TEXT,
  p_delivery TEXT,
  p_attempt INTEGER DEFAULT 0,
  p_elapsed_ms INTEGER DEFAULT 0,
  p_build_id TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_detail JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_exists BOOLEAN;
BEGIN
  -- A real, recent broadcast. Not an entitlement check: a viewer who
  -- cannot watch a gated live still has a device that failed, and that
  -- failure is worth recording. It only stops the table being written
  -- against arbitrary or ancient uuids.
  SELECT TRUE INTO v_exists
  FROM public.live_sessions s
  WHERE s.id = p_session_id
    AND s.created_at > now() - INTERVAL '1 day';

  IF v_exists IS NOT TRUE THEN
    RETURN;
  END IF;

  -- Fixed vocabularies. An unknown value is dropped rather than stored,
  -- so a query over `step` never has to cope with whatever a caller felt
  -- like sending.
  IF p_step NOT IN ('normal', 'relay', 'rebuild', 'reload', 'failed', 'stale_build', 'wake', 'watchdog')
     OR p_outcome NOT IN ('entered', 'recovered', 'timed_out', 'skipped', 'gave_up', 'detected')
     OR p_delivery NOT IN ('hls', 'livekit') THEN
    RETURN;
  END IF;

  INSERT INTO public.live_viewer_diagnostics (
    session_id, user_id, client_id, step, outcome, delivery,
    attempt, elapsed_ms, build_id, user_agent, detail
  )
  VALUES (
    p_session_id,
    auth.uid(),
    left(p_client_id, 64),
    p_step,
    p_outcome,
    p_delivery,
    -- Clamped rather than trusted: these land in a chart.
    LEAST(GREATEST(COALESCE(p_attempt, 0), 0), 1000),
    LEAST(GREATEST(COALESCE(p_elapsed_ms, 0), 0), 3600000),
    left(p_build_id, 64),
    left(p_user_agent, 400),
    -- A whole-value cap: `detail` is the one open-ended column, and
    -- without this it is a place to store a megabyte.
    CASE
      WHEN p_detail IS NULL THEN NULL
      WHEN length(p_detail::text) > 2000 THEN jsonb_build_object('truncated', true)
      ELSE p_detail
    END
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.log_live_viewer_diagnostic(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, JSONB
) FROM PUBLIC;

-- anon included: see the header. A logged-out viewer on a public
-- broadcast is exactly the device this data is about.
GRANT EXECUTE ON FUNCTION public.log_live_viewer_diagnostic(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, JSONB
) TO anon, authenticated, service_role;
