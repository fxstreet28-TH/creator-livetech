-- =====================================================================
-- AURUM Live — OBS browser-source overlay keys (Phase E of live gifts)
--
-- A creator who streams through OBS instead of the in-browser publisher
-- still wants the gift overlay on their canvas. OBS's browser source is a
-- bare Chromium with no login, no cookies worth relying on and no way to
-- complete an auth flow — so it needs a URL that authenticates by itself.
--
-- That URL carries a per-creator KEY. The key is not a session token: it
-- is exchanged, by `live-overlay-token`, for a short-lived Supabase JWT
-- that the overlay page uses to join the private `live:<session_id>`
-- channel under the SAME RLS as everybody else. Nothing is widened for
-- OBS; the browser source simply arrives holding a credential.
--
-- WHY THE KEY IS NOT A COLUMN ON `creators`
--
-- The brief specified `creators.overlay_key`. It cannot safely live
-- there. `creators` carries
--
--   creators_public_read  FOR SELECT TO authenticated USING (true)
--
-- so every signed-in user can read every column of every creator row, and
-- a `select=*` through PostgREST would hand each of them every creator's
-- overlay key — a credential that mints a JWT for that creator's user id.
-- Column-level GRANTs could exclude it, but they must then enumerate
-- every OTHER column and be updated by hand whenever one is added; the
-- day someone forgets, reads break, and the day someone "fixes" it with
-- `GRANT SELECT ON creators` the key is public again with nothing to
-- notice.
--
-- A separate table has no read policy at all. There is no grant to
-- revoke, no column list to maintain, and the only way to the key is
-- through the two SECURITY DEFINER functions below.
--
-- Applied to hknvooaqgpufrbdxtzxf via Supabase MCP as
-- `live_gift_overlay_keys`.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.creator_overlay_keys (
  creator_id  UUID PRIMARY KEY REFERENCES public.creators(id) ON DELETE CASCADE,
  -- 32 url-safe characters. Unique so a key identifies exactly one creator.
  overlay_key TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at  TIMESTAMPTZ
);

COMMENT ON TABLE public.creator_overlay_keys IS
  'Per-creator OBS overlay credentials. No RLS policy exists and no client grant is issued: reachable only through get_creator_overlay_key (the owner) and resolve_overlay_session (service_role).';

COMMENT ON COLUMN public.creator_overlay_keys.overlay_key IS
  'SECURITY: a bearer credential. Exchanges for a 12h JWT scoped to this creator. Never log it, never return it to anyone but its owner.';

ALTER TABLE public.creator_overlay_keys ENABLE ROW LEVEL SECURITY;

-- Deliberately no policy. RLS with no policy denies everything, and the
-- revoke below means a client cannot even reach the check.
REVOKE ALL ON public.creator_overlay_keys FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Minting
-- ---------------------------------------------------------------------------
--
-- `gen_random_bytes(24)` base64-encodes to exactly 32 characters with no
-- padding, which is why 24 and not 16 or 32: 16 gives 24 characters with an
-- `=` to strip, 32 gives 44. The two substitutions turn base64 into base64url
-- so the key survives a query string without escaping.
--
-- 192 bits. The threat is someone guessing a key that unlocks a creator's
-- overlay; at any rate a network permits, that is not a threat.

CREATE OR REPLACE FUNCTION public.generate_overlay_key()
RETURNS TEXT
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'extensions'
AS $$
  SELECT translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_');
$$;

REVOKE ALL ON FUNCTION public.generate_overlay_key() FROM PUBLIC, anon, authenticated;

/*
 * The creator's own key, created on first request.
 *
 * `p_regenerate` is the "ลิงก์เดิมใช้ไม่ได้แล้ว" button on /settings: it
 * replaces the key, which immediately invalidates every URL anyone has
 * copied — the point of having one. Tokens already minted from the old key
 * live out their 12 hours; revoking those would need a token denylist, and
 * the thing being protected is a read-only overlay of the creator's own
 * gifts.
 */
CREATE OR REPLACE FUNCTION public.get_creator_overlay_key(p_regenerate BOOLEAN DEFAULT false)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_creator_id UUID;
  v_key        TEXT;
BEGIN
  -- The CALLER's creator row, never one named in an argument. A creator id
  -- parameter would make this function a way to read anybody's key.
  SELECT id INTO v_creator_id
  FROM public.creators
  WHERE user_id = auth.uid();

  IF v_creator_id IS NULL THEN
    RAISE EXCEPTION 'NOT_A_CREATOR' USING DETAIL = 'No creators row for the calling user';
  END IF;

  IF p_regenerate THEN
    v_key := public.generate_overlay_key();
    INSERT INTO public.creator_overlay_keys (creator_id, overlay_key, rotated_at)
    VALUES (v_creator_id, v_key, now())
    ON CONFLICT (creator_id) DO UPDATE
      SET overlay_key = EXCLUDED.overlay_key,
          rotated_at  = now();
    RETURN v_key;
  END IF;

  SELECT overlay_key INTO v_key
  FROM public.creator_overlay_keys
  WHERE creator_id = v_creator_id;

  IF v_key IS NOT NULL THEN
    RETURN v_key;
  END IF;

  v_key := public.generate_overlay_key();
  INSERT INTO public.creator_overlay_keys (creator_id, overlay_key)
  VALUES (v_creator_id, v_key)
  -- Two tabs asking at once: the loser takes the winner's key rather than
  -- raising, so neither creator sees an error for pressing a button twice.
  ON CONFLICT (creator_id) DO UPDATE SET overlay_key = public.creator_overlay_keys.overlay_key
  RETURNING overlay_key INTO v_key;

  RETURN v_key;
END;
$$;

REVOKE ALL ON FUNCTION public.get_creator_overlay_key(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_creator_overlay_key(BOOLEAN) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Redeeming
-- ---------------------------------------------------------------------------
--
-- Answers ONE question: does this key belong to the creator of this session,
-- and is that session still running? Returns the creator's auth user id, which
-- is what `live-overlay-token` puts in the JWT's `sub` — so the overlay ends up
-- authenticated as the creator, and `can_watch_live_session` lets it onto the
-- channel for the same reason it lets the creator's own studio on.
--
-- NULL for every failure, with no distinction between a wrong key, an unknown
-- session and a finished one. The caller answers 403 for all three: telling an
-- unauthenticated caller WHICH part of its guess was wrong is how a key gets
-- brute-forced session by session.
--
-- service_role only. This is the one function that turns a key into an
-- identity, and `authenticated` has no business calling it.

CREATE OR REPLACE FUNCTION public.resolve_overlay_session(
  p_session_id  UUID,
  p_overlay_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  IF p_session_id IS NULL OR p_overlay_key IS NULL OR length(p_overlay_key) < 16 THEN
    RETURN NULL;
  END IF;

  SELECT c.user_id INTO v_user_id
  FROM public.live_sessions s
  JOIN public.creators c ON c.id = s.creator_id
  JOIN public.creator_overlay_keys k ON k.creator_id = s.creator_id
  WHERE s.id = p_session_id
    AND k.overlay_key = p_overlay_key
    AND s.ended_at IS NULL
    AND s.status IN ('waiting', 'live', 'paused');

  RETURN v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_overlay_session(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_overlay_session(UUID, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- What `get_advisors(security)` says about the above, and why it is right
-- ---------------------------------------------------------------------------
--
-- Two entries name objects created here. Both are the design, not a gap, and
-- they are written down so nobody "fixes" them later:
--
--  1. INFO rls_enabled_no_policy on `public.creator_overlay_keys`.
--     That is the point. RLS with no policy denies every row to every client
--     role, and the grants are revoked on top of it, so there is nothing to
--     get wrong: the only readers are the two SECURITY DEFINER functions.
--     ADDING a policy here would be the mistake.
--
--  2. WARN authenticated_security_definer_function_executable on
--     `get_creator_overlay_key`. Also intended — a creator has to be able to
--     ask for their OWN key, and there is no other way to reach a table with
--     no policy. What makes it safe is that the function takes no creator id:
--     it resolves the row from `auth.uid()`, so the caller can only ever
--     obtain their own. `resolve_overlay_session`, which turns a key into an
--     identity, is service_role only and does NOT appear in the advisors.
--
-- Nothing else in this migration, and nothing in `live_gifts_v1`, is flagged.
