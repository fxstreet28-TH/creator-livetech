-- =====================================================================
-- set_live_viewer_counts: the NULL-safe ownership guard.
--
-- The same hole `touch_live_heartbeat` had, in the function it was
-- modelled on. Fixed there when QA caught a heartbeat landing from an
-- unauthenticated session; flagged then as out of scope, and this is it
-- being closed.
--
--     IF v_owner IS NULL OR v_owner <> auth.uid() THEN RETURN; END IF;
--
-- When auth.uid() is NULL, `v_owner <> auth.uid()` is NULL, `FALSE OR
-- NULL` is NULL, and `IF NULL THEN` does not fire — so a caller with no
-- `sub` claim falls straight through the guard and gets the write.
--
-- WHAT THAT WRITE IS. `current_viewer_count` is what the discover card and
-- the dashboard strip show, and `peak_viewer_count` is read by
-- live-end-session to build the session summary AND to PRICE the
-- broadcast (estimateLiveCost multiplies it by the duration). A peak
-- anyone could set is a bill anyone could inflate.
--
-- `IS DISTINCT FROM` is NULL-safe and answers TRUE against a NULL, which
-- refuses. Everything else about the function is unchanged — same
-- signature, same GREATEST-based peak, same status filter.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.set_live_viewer_counts(
  p_session_id UUID,
  p_current INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_owner UUID;
BEGIN
  -- Only the broadcaster may write their own audience size.
  SELECT c.user_id INTO v_owner
  FROM public.live_sessions s
  JOIN public.creators c ON c.id = s.creator_id
  WHERE s.id = p_session_id;

  -- IS DISTINCT FROM, not <> — see the header.
  IF v_owner IS NULL OR v_owner IS DISTINCT FROM auth.uid() THEN
    RETURN;
  END IF;

  UPDATE public.live_sessions
  SET current_viewer_count = GREATEST(0, p_current),
      -- Raised with GREATEST server-side: two writes in flight at once (the
      -- broadcaster's timer and its new-peak write) could otherwise walk the
      -- maximum backwards, and live-end-session reads that peak to build the
      -- session summary and the bill.
      peak_viewer_count = GREATEST(peak_viewer_count, GREATEST(0, p_current)),
      updated_at = now()
  WHERE id = p_session_id
    AND status IN ('waiting', 'live');
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_live_viewer_counts(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_live_viewer_counts(UUID, INTEGER) TO authenticated, service_role;
