-- =====================================================================
-- AURUM Live — live gifts (`live_gifts_v1`)
--
-- TikTok-style gifting while a creator is on air. A viewer buys one of
-- seven น้อง Aurum tiers with stars from the wallet they already have, the
-- creator is credited on the ledger tips and PPV already use, and an
-- animated overlay plays on every screen watching the session.
--
-- THREE THINGS THIS MIGRATION DELIBERATELY DOES NOT DO
--
--  1. It does not open a second earnings ledger. There is exactly one
--     place a creator's stars are recorded — `star_transactions`, with
--     `creator_id` set on the SPEND row — and that is what
--     `deduct_stars_fifo` already writes. Commission is applied at monthly
--     payout on the total, so a gift is a tip with a mascot on it and
--     needs no money plumbing of its own. A parallel table would be a
--     second number for finance to reconcile and a second place to be
--     wrong.
--
--  2. It does not reimplement the FIFO spend. The brief allowed for the
--     possibility that the FIFO logic lived in TypeScript and would have to
--     be moved into SQL; it does not — `deduct_stars_fifo` (migration
--     `phase1_wallet_rpcs`) is already the atomic, row-locking
--     implementation, and `_shared/stars.ts` is a typed wrapper over it.
--     So `send_live_gift` calls it, and there is still one implementation.
--
--  3. It does not open a new Realtime channel. The gift event is broadcast
--     on `live:<session_id>` — the same private topic chat, reactions and
--     presence already ride, gated by the `realtime.messages` policies in
--     `20260901_bunny_live_migration.sql`. Those policies are written per
--     TOPIC and not per event, so they already authorise this event for
--     exactly the people entitled to watch, with no widening needed. That
--     is checked at the bottom of this file rather than assumed.
--
-- Applied to hknvooaqgpufrbdxtzxf via Supabase MCP as `live_gifts_v1`.
-- =====================================================================

-- ---------------------------------------------------------------------------
-- 1. gift_tiers — the catalogue
-- ---------------------------------------------------------------------------
--
-- Prices live HERE and only here. Nothing in the frontend may hardcode one:
-- the CEO sets final pricing later with an UPDATE, and a price baked into a
-- React component would then charge one number and display another.

CREATE TABLE IF NOT EXISTS public.gift_tiers (
  id             SMALLINT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name_en        TEXT NOT NULL,
  name_th        TEXT NOT NULL,
  subtitle_th    TEXT,
  rarity         TEXT NOT NULL CHECK (rarity IN ('basic','rare','epic','legendary','mythic')),
  price_stars    INTEGER NOT NULL CHECK (price_stars > 0),
  -- Which animation component renders this tier. A key rather than a
  -- component name so the registry in the frontend is the only place that
  -- mapping exists; an unknown key falls back to the generic float rather
  -- than rendering nothing.
  animation_key  TEXT NOT NULL,
  duration_ms    INTEGER NOT NULL DEFAULT 4500 CHECK (duration_ms BETWEEN 1000 AND 30000),
  display_mode   TEXT NOT NULL DEFAULT 'tray' CHECK (display_mode IN ('tray','fullscreen')),
  max_quantity   INTEGER NOT NULL DEFAULT 99 CHECK (max_quantity BETWEEN 1 AND 999),
  sort_order     SMALLINT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.gift_tiers.price_stars IS
  'Stars per unit. PLACEHOLDER pricing — CEO sets the final numbers by UPDATE. Never hardcoded client-side.';

-- Seed. Tiers 5-7 have mascot art but no name or reference animation yet, so
-- they carry a TBD name and the generic float; replacing them is an UPDATE,
-- not a migration.
-- TODO CEO pricing — every price_stars below is a placeholder.
INSERT INTO public.gift_tiers
  (id, slug, name_en, name_th, subtitle_th, rarity, price_stars, animation_key, duration_ms, display_mode, sort_order)
VALUES
  (1, 'stardust',  'Stardust',  'ผงดาว',    'ทักทายแรกเริ่ม',      'basic',     1,    'stardust',  4500,  'tray',       1),
  (2, 'moonlight', 'Moonlight', 'แสงจันทร์', 'ส่องทางให้เธอ',       'rare',      5,    'moonlight', 5500,  'tray',       2),
  (3, 'comet',     'Comet',     'ดาวหาง',   'พุ่งมาหาเธอทันที',     'epic',      20,   'comet',     6500,  'fullscreen', 3),
  (4, 'nova',      'Nova',      'โนวา',     'ฮีโร่ผู้ปกป้องโลก',    'legendary', 100,  'nova',      10000, 'fullscreen', 4),
  (5, 'tier-05',   'TBD',       'TBD',      NULL,                  'legendary', 300,  'generic',   3500,  'fullscreen', 5),
  (6, 'tier-06',   'TBD',       'TBD',      NULL,                  'mythic',    1000, 'generic',   3500,  'fullscreen', 6),
  (7, 'tier-07',   'TBD',       'TBD',      NULL,                  'mythic',    3000, 'generic',   3500,  'fullscreen', 7)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.gift_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gift_tiers_read_active" ON public.gift_tiers;
CREATE POLICY "gift_tiers_read_active"
  ON public.gift_tiers
  FOR SELECT
  TO authenticated
  USING (is_active = true);

-- SELECT only, and only the columns' worth of privilege the read policy
-- needs. Same shape as the Week 3 grant tightening: a catalogue nobody can
-- TRUNCATE is one less thing RLS has to be right about.
REVOKE ALL ON public.gift_tiers FROM anon, authenticated;
GRANT SELECT ON public.gift_tiers TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. live_gifts — one row per gift sent
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.live_gifts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES public.live_sessions(id) ON DELETE CASCADE,
  creator_id    UUID NOT NULL REFERENCES public.creators(id),
  sender_id     UUID NOT NULL REFERENCES auth.users(id),
  tier_id       SMALLINT NOT NULL REFERENCES public.gift_tiers(id),
  quantity      INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  stars_total   INTEGER NOT NULL CHECK (stars_total > 0),
  message       TEXT CHECK (char_length(message) <= 80),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_gifts_session ON public.live_gifts (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_gifts_creator ON public.live_gifts (creator_id, created_at DESC);
-- Also the rate-limit index: the per-minute window is a range scan on
-- (sender_id, created_at), which is exactly this.
CREATE INDEX IF NOT EXISTS idx_live_gifts_sender  ON public.live_gifts (sender_id, created_at DESC);

ALTER TABLE public.live_gifts ENABLE ROW LEVEL SECURITY;

-- Reading. Three audiences in one policy rather than three policies, because
-- they overlap: the sender (their own history, including after the session
-- ends), the creator (their own sessions' gifts, likewise), and anyone
-- currently entitled to watch the session — which is what the "recent gifts"
-- strip needs and what `can_watch_live_session` already decides for the video
-- and the chat channel. Note the third clause goes false once a session ends;
-- the first two are what keep history readable afterwards.
DROP POLICY IF EXISTS "live_gifts_read" ON public.live_gifts;
CREATE POLICY "live_gifts_read"
  ON public.live_gifts
  FOR SELECT
  TO authenticated
  USING (
    sender_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.creators c
      WHERE c.id = live_gifts.creator_id
        AND c.user_id = (SELECT auth.uid())
    )
    OR public.can_watch_live_session(live_gifts.session_id, (SELECT auth.uid()))
  );

-- No INSERT, UPDATE or DELETE policy exists, and none should: `send_live_gift`
-- is the only writer and it runs as the definer. A client that could insert
-- here could credit a creator without spending a star.
REVOKE ALL ON public.live_gifts FROM anon, authenticated;
GRANT SELECT ON public.live_gifts TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Session-level gift totals
-- ---------------------------------------------------------------------------
--
-- `tip_stars_received` already exists and already means "stars this session
-- earned", and live-end-session reports it as ดาวที่ได้รับ. Gifts add to it
-- rather than to a rival column — otherwise the summary would understate the
-- broadcast by exactly the amount the gifts were worth. `gift_count` and
-- `gift_stars_total` are the gift-only breakdown next to it, which is what the
-- creator's stats strip shows.

ALTER TABLE public.live_sessions
  ADD COLUMN IF NOT EXISTS gift_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gift_stars_total INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.live_sessions.gift_stars_total IS
  'Stars from live gifts only. Also included in tip_stars_received, which is the session total across every earning path.';

-- ---------------------------------------------------------------------------
-- 4. send_live_gift — the one writer
-- ---------------------------------------------------------------------------
--
-- Everything below happens in the caller's transaction, so a failure at any
-- step leaves NO trace: no half-spent wallet, no gift row for stars that were
-- never taken. That is the whole reason this is one plpgsql function rather
-- than a sequence of calls from the Edge Function, which cannot take a lock or
-- roll back.
--
-- Failures are raised, not returned, and the message IS the machine-readable
-- code — `live-send-gift` maps it onto the Thai copy and the HTTP status.
-- INSUFFICIENT_STARS carries the two numbers the balance sheet needs in
-- DETAIL, as JSON.

CREATE OR REPLACE FUNCTION public.send_live_gift(
  p_session_id UUID,
  p_sender_id  UUID,
  p_tier_id    SMALLINT,
  p_quantity   INTEGER,
  p_message    TEXT
)
RETURNS public.live_gifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_session         public.live_sessions;
  v_tier            public.gift_tiers;
  v_creator_user_id UUID;
  v_stars_total     INTEGER;
  v_recent_sends    INTEGER;
  v_recent_stars    INTEGER;
  v_deduction       JSONB;
  v_message         TEXT;
  v_gift            public.live_gifts;
BEGIN
  IF p_session_id IS NULL OR p_sender_id IS NULL OR p_tier_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING DETAIL = 'session_id, sender_id and tier_id are required';
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING DETAIL = 'quantity must be at least 1';
  END IF;

  -- 1. The session, locked. FOR UPDATE both serialises the counter bumps at
  -- the bottom and pins `status` for the length of the transaction: without
  -- it, a gift can be accepted against a session the creator ended a
  -- microsecond later, and the stars would be spent into a finished broadcast.
  SELECT * INTO v_session
  FROM public.live_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.status <> 'live' OR v_session.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_NOT_LIVE' USING DETAIL = 'Session is not accepting gifts';
  END IF;

  -- 2. No self-gifting. A creator gifting their own session would spend N
  -- stars to be credited N stars less the payout commission — a guaranteed
  -- loss dressed up as engagement, and the obvious shape of a wash-trading
  -- attempt on any metric built from gift volume.
  SELECT user_id INTO v_creator_user_id
  FROM public.creators
  WHERE id = v_session.creator_id;

  IF v_creator_user_id IS NOT NULL AND v_creator_user_id = p_sender_id THEN
    RAISE EXCEPTION 'SELF_GIFT' USING DETAIL = 'A creator cannot gift their own session';
  END IF;

  -- 3. The tier, and what it costs.
  SELECT * INTO v_tier FROM public.gift_tiers WHERE id = p_tier_id;

  IF NOT FOUND OR v_tier.is_active = false THEN
    RAISE EXCEPTION 'TIER_INACTIVE' USING DETAIL = 'Gift tier is not available';
  END IF;

  IF p_quantity > v_tier.max_quantity THEN
    RAISE EXCEPTION 'QUANTITY_TOO_HIGH'
      USING DETAIL = json_build_object('max_quantity', v_tier.max_quantity)::text;
  END IF;

  -- 4. Priced in the database, from the row just read under the tier's own
  -- CHECK constraints. The client sends a tier and a count, never a price.
  v_stars_total := v_tier.price_stars * p_quantity;

  -- 5. Rate limit, before any money moves.
  --
  -- The ledger is `live_gifts` itself — it already carries sender, stars and
  -- timestamp, and already has the (sender_id, created_at) index the window
  -- scan wants, so a separate counter table would be a second thing to keep
  -- in step with the first. Only successful sends count against the limit,
  -- which is the right measure for an AML ceiling: what actually moved.
  --
  -- 20,000 stars/minute is the AML echo of the 50,000-star wallet cap — a
  -- full wallet cannot be emptied into one creator in under three minutes.
  SELECT count(*), COALESCE(sum(stars_total), 0)
    INTO v_recent_sends, v_recent_stars
  FROM public.live_gifts
  WHERE sender_id = p_sender_id
    AND created_at > now() - INTERVAL '1 minute';

  IF v_recent_sends >= 30 THEN
    RAISE EXCEPTION 'RATE_LIMITED'
      USING DETAIL = json_build_object('limit', 'sends_per_minute', 'max', 30)::text;
  END IF;

  IF v_recent_stars + v_stars_total > 20000 THEN
    RAISE EXCEPTION 'RATE_LIMITED'
      USING DETAIL = json_build_object('limit', 'stars_per_minute', 'max', 20000,
                                       'used', v_recent_stars)::text;
  END IF;

  -- 6. The gift row first, so the spend can reference it.
  --
  -- Ordering note: the insert has to precede the deduction because
  -- `star_transactions.reference_id` points at this row and there is nothing
  -- to point at until it exists. It is safe in the other direction — the
  -- deduction raises or reports failure inside the same transaction, and this
  -- row goes with it.
  v_message := NULLIF(btrim(COALESCE(p_message, '')), '');
  IF v_message IS NOT NULL THEN
    v_message := left(v_message, 80);
  END IF;

  INSERT INTO public.live_gifts
    (session_id, creator_id, sender_id, tier_id, quantity, stars_total, message)
  VALUES
    (p_session_id, v_session.creator_id, p_sender_id, p_tier_id, p_quantity, v_stars_total, v_message)
  RETURNING * INTO v_gift;

  -- 7. Spend, on the existing FIFO path — oldest-expiring batch first, wallet
  -- row locked, `star_transactions` written with `creator_id` set. That
  -- ledger row IS the creator's credit: it is the same row a tip or a PPV
  -- unlock writes, read the same way by payouts, so gifts need no second
  -- earnings path. `reference_type` names this table so the wallet screen can
  -- resolve the row back to the gift it paid for.
  v_deduction := public.deduct_stars_fifo(
    p_sender_id,
    v_stars_total,
    'live_gift',
    v_gift.id,
    'live_gift',
    v_session.creator_id
  );

  IF COALESCE((v_deduction->>'success')::boolean, false) = false THEN
    -- Reported rather than raised by deduct_stars_fifo, so the refusal has to
    -- be turned into one here — otherwise the transaction would commit a gift
    -- nobody paid for.
    RAISE EXCEPTION 'INSUFFICIENT_STARS'
      USING DETAIL = json_build_object(
        'balance', COALESCE((v_deduction->>'new_wallet_balance')::int, 0),
        'required', v_stars_total
      )::text;
  END IF;

  -- 8. Session counters. `tip_stars_received` is the session total across
  -- every earning path; the two gift columns are the breakdown.
  UPDATE public.live_sessions
  SET gift_count         = gift_count + 1,
      gift_stars_total   = gift_stars_total + v_stars_total,
      tip_stars_received = tip_stars_received + v_stars_total,
      updated_at         = now()
  WHERE id = p_session_id;

  RETURN v_gift;
END;
$$;

REVOKE ALL ON FUNCTION public.send_live_gift(UUID, UUID, SMALLINT, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_live_gift(UUID, UUID, SMALLINT, INTEGER, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 5. The broadcast
-- ---------------------------------------------------------------------------
--
-- Fired by the database rather than by the Edge Function, so the event cannot
-- disagree with the row: there is no path that writes a gift without
-- announcing it, and none that announces one that did not commit.
--
-- The sender's NAME is resolved here rather than taken from the request, which
-- is the one place this design is stricter than chat: a chat line carries a
-- display name its own sender wrote, so the 👑 on it is a comparison rather
-- than a signature (see lib/live/realtime.ts). A gift is money, and the name
-- on it is the database's answer, not the spender's claim.

CREATE OR REPLACE FUNCTION public.live_gifts_broadcast()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tier          public.gift_tiers;
  v_display_name  TEXT;
  v_avatar_url    TEXT;
  v_meta          JSONB;
  v_email         TEXT;
BEGIN
  SELECT * INTO v_tier FROM public.gift_tiers WHERE id = NEW.tier_id;

  -- The SENDER's name, not the creator's, and derived with the SAME precedence
  -- the rest of the app uses (deriveDisplayName in lib/hooks/useDashboardUser):
  -- an explicit metadata name, then the email local-part, then a friendly Thai
  -- default. Matching it matters — a viewer named by their email prefix in the
  -- chat panel and "ผู้ชม" in the gift row beside it reads as two people.
  --
  -- `public.creators.display_name` comes first because a creator sending a gift
  -- to another creator has a real, chosen name that their metadata may not
  -- carry.
  SELECT c.display_name INTO v_display_name
  FROM public.creators c
  WHERE c.user_id = NEW.sender_id
  LIMIT 1;

  SELECT u.raw_user_meta_data, u.email INTO v_meta, v_email
  FROM auth.users u
  WHERE u.id = NEW.sender_id;

  v_display_name := COALESCE(
    NULLIF(btrim(COALESCE(v_display_name, '')), ''),
    NULLIF(btrim(COALESCE(v_meta->>'display_name', '')), ''),
    NULLIF(btrim(COALESCE(v_meta->>'full_name', '')), ''),
    NULLIF(btrim(COALESCE(v_meta->>'name', '')), ''),
    NULLIF(split_part(COALESCE(v_email, ''), '@', 1), ''),
    'ผู้ชม'
  );

  -- Same source the avatar comes from everywhere else. Null is normal and the
  -- overlay renders initials for it; nothing here invents a URL.
  v_avatar_url := NULLIF(btrim(COALESCE(v_meta->>'avatar_url', '')), '');

  PERFORM realtime.send(
    jsonb_build_object(
      'gift_id',       NEW.id,
      'session_id',    NEW.session_id,
      'tier_id',       NEW.tier_id,
      'tier_slug',     v_tier.slug,
      'name_en',       v_tier.name_en,
      'name_th',       v_tier.name_th,
      'rarity',        v_tier.rarity,
      'animation_key', v_tier.animation_key,
      'display_mode',  v_tier.display_mode,
      'duration_ms',   v_tier.duration_ms,
      'quantity',      NEW.quantity,
      'stars_total',   NEW.stars_total,
      'message',       NEW.message,
      'sender', jsonb_build_object(
        'id',           NEW.sender_id,
        'display_name', v_display_name,
        'avatar_url',   v_avatar_url
      ),
      'created_at',    NEW.created_at
    ),
    'gift',                                   -- event
    'live:' || NEW.session_id::text,          -- the channel chat already uses
    true                                      -- private
  );

  RETURN NULL;  -- AFTER trigger; the return value is discarded either way.
END;
$$;

REVOKE ALL ON FUNCTION public.live_gifts_broadcast() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS live_gifts_broadcast_trigger ON public.live_gifts;
CREATE TRIGGER live_gifts_broadcast_trigger
  AFTER INSERT ON public.live_gifts
  FOR EACH ROW
  EXECUTE FUNCTION public.live_gifts_broadcast();

-- ---------------------------------------------------------------------------
-- 6. The channel policies already cover this
-- ---------------------------------------------------------------------------
--
-- `live_channel_receive` (20260901_bunny_live_migration.sql) is written
-- against `realtime.topic()` alone — it authorises a SUBSCRIPTION to
-- `live:<uuid>`, not an event name — so a viewer entitled to the session
-- receives 'gift' for the same reason they receive 'chat', and nothing needs
-- widening. Restated here as an executable assertion rather than a comment,
-- so that a future narrowing of that policy fails THIS migration's re-run
-- instead of silently taking the overlay off every viewer's screen.

DO $$
DECLARE
  v_qual TEXT;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid)
    INTO v_qual
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'realtime' AND c.relname = 'messages'
    AND pol.polname = 'live_channel_receive';

  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'live_channel_receive policy is missing — gifts would broadcast to nobody';
  END IF;

  -- Topic-scoped is the property that matters: the policy must decide on the
  -- session parsed out of the topic, which authorises every event on it.
  IF v_qual NOT LIKE '%live_session_id_from_topic%'
     OR v_qual NOT LIKE '%can_watch_live_session%' THEN
    RAISE EXCEPTION 'live_channel_receive is no longer topic-scoped (%) — check that the gift event still reaches viewers', v_qual;
  END IF;
END;
$$;
