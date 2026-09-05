-- =====================================================================
-- AURUM Live — FREE PREVIEW mode for live gifts
--
-- The CEO needs to see every tier land on a real broadcast before pricing
-- is decided, and cannot do that while each look costs stars. So a gift
-- priced at 0 becomes a first-class case rather than a special one:
--
--   price_stars = 0  ->  no spend, no creator credit, no ledger row,
--                        no stars-per-minute ceiling. Everything else —
--                        the session lock, the self-gift refusal, the
--                        30-sends-per-minute ceiling, the row, the
--                        broadcast, the overlay — is unchanged.
--
-- THIS IS A KILL SWITCH, NOT A FLAG. There is no `is_free_preview`
-- column and no environment variable, because either would be a second
-- thing that has to agree with the price. The price IS the switch:
--
--   update public.gift_tiers set price_stars = 100 where id = 4;
--
-- turns Nova back into a paid gift, in one statement, with no deploy and
-- no code path that only runs in one mode. The frontend reads the same
-- rows and stops saying "ฟรี" by itself.
--
-- Applied to hknvooaqgpufrbdxtzxf via Supabase MCP as
-- `live_gifts_free_preview`.
-- =====================================================================

-- ---------------------------------------------------------------------------
-- 1. Zero becomes a legal price
-- ---------------------------------------------------------------------------
--
-- Both constraints were `> 0`, which is what a paid-only design should say —
-- and is now exactly what blocks a free tier from being seeded or a free gift
-- from being recorded. Relaxed to `>= 0`; NEGATIVE is still refused, which is
-- the part that actually matters (a negative price would credit the sender).

ALTER TABLE public.gift_tiers
  DROP CONSTRAINT IF EXISTS gift_tiers_price_stars_check;
ALTER TABLE public.gift_tiers
  ADD CONSTRAINT gift_tiers_price_stars_check CHECK (price_stars >= 0);

ALTER TABLE public.live_gifts
  DROP CONSTRAINT IF EXISTS live_gifts_stars_total_check;
ALTER TABLE public.live_gifts
  ADD CONSTRAINT live_gifts_stars_total_check CHECK (stars_total >= 0);

COMMENT ON COLUMN public.gift_tiers.price_stars IS
  'Stars per unit. 0 means the tier is FREE — send_live_gift then skips the spend, the creator credit and the AML star ceiling. Setting a price back above 0 restores the paid path with no deploy.';

-- ---------------------------------------------------------------------------
-- 2. send_live_gift: a free gift moves no money
-- ---------------------------------------------------------------------------
--
-- The diff against `live_gifts_v1` is deliberately small and all of it is
-- guarded on `v_stars_total = 0`. A paid send takes exactly the path it took
-- before, statement for statement, so flipping prices back cannot regress
-- anything that was not exercised while free.

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
  -- the bottom and pins `status` for the length of the transaction.
  SELECT * INTO v_session
  FROM public.live_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.status <> 'live' OR v_session.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_NOT_LIVE' USING DETAIL = 'Session is not accepting gifts';
  END IF;

  -- 2. No self-gifting.
  --
  -- Still refused while gifts are free. The money reason (a guaranteed loss to
  -- commission) has gone for now, but the OTHER reason has not: a creator
  -- inflating their own gift count is wash-trading whatever the price, and
  -- gift_count is a number the platform will be judged on.
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

  -- 4. Priced in the database, from the row just read. Zero is a legal answer.
  v_stars_total := v_tier.price_stars * p_quantity;

  -- 5. Rate limits.
  --
  -- The SEND ceiling always applies, free or not: it is what stops a script
  -- from filling a creator's overlay with 600 animations a minute, and that
  -- abuse costs nothing to mount precisely when gifts are free.
  --
  -- The STAR ceiling is an AML control on money movement. A free gift moves no
  -- money, so it is not weighed against it — and, more importantly, is not
  -- COUNTED into it: `sum(stars_total)` over free rows is 0 either way, so the
  -- window stays honest the moment a tier is priced again mid-broadcast.
  SELECT count(*), COALESCE(sum(stars_total), 0)
    INTO v_recent_sends, v_recent_stars
  FROM public.live_gifts
  WHERE sender_id = p_sender_id
    AND created_at > now() - INTERVAL '1 minute';

  IF v_recent_sends >= 30 THEN
    RAISE EXCEPTION 'RATE_LIMITED'
      USING DETAIL = json_build_object('limit', 'sends_per_minute', 'max', 30)::text;
  END IF;

  IF v_stars_total > 0 AND v_recent_stars + v_stars_total > 20000 THEN
    RAISE EXCEPTION 'RATE_LIMITED'
      USING DETAIL = json_build_object('limit', 'stars_per_minute', 'max', 20000,
                                       'used', v_recent_stars)::text;
  END IF;

  -- 6. The gift row first, so the spend can reference it.
  v_message := NULLIF(btrim(COALESCE(p_message, '')), '');
  IF v_message IS NOT NULL THEN
    v_message := left(v_message, 80);
  END IF;

  INSERT INTO public.live_gifts
    (session_id, creator_id, sender_id, tier_id, quantity, stars_total, message)
  VALUES
    (p_session_id, v_session.creator_id, p_sender_id, p_tier_id, p_quantity, v_stars_total, v_message)
  RETURNING * INTO v_gift;

  -- 7. Spend and credit — ONLY when there is something to move.
  --
  -- `deduct_stars_fifo` is not called with 0: it refuses a non-positive amount
  -- (correctly), and calling it would turn every free gift into an
  -- INSUFFICIENT_STARS. Skipping it also means no `star_transactions` row is
  -- written, which is the honest record — nothing was spent and nobody was
  -- credited, so an earnings ledger with a 0-star line in it would be a line
  -- payouts has to learn to ignore.
  IF v_stars_total > 0 THEN
    v_deduction := public.deduct_stars_fifo(
      p_sender_id,
      v_stars_total,
      'live_gift',
      v_gift.id,
      'live_gift',
      v_session.creator_id
    );

    IF COALESCE((v_deduction->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'INSUFFICIENT_STARS'
        USING DETAIL = json_build_object(
          'balance', COALESCE((v_deduction->>'new_wallet_balance')::int, 0),
          'required', v_stars_total
        )::text;
    END IF;
  END IF;

  -- 8. Session counters.
  --
  -- `gift_count` always moves — a free gift still happened, and it is what the
  -- creator's strip and the end-live summary count. The two STAR totals move by
  -- v_stars_total, which is 0 for a free gift, so they are left exactly as they
  -- were without needing a branch.
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
-- 3. `sort_order` joins the broadcast payload
-- ---------------------------------------------------------------------------
--
-- The fullscreen queue plays the most valuable pending gift first, within a
-- 2-second batch window. With every price at 0 that comparison ties on every
-- gift and the queue degrades to plain FIFO — so a Nova sent a moment after a
-- Comet would wait behind it, which is the one ordering rule the overlay has.
--
-- The catalogue already ranks the tiers; the event just never carried the rank.
-- It does now, and the client breaks a stars tie on it. `tier_id` would have
-- been a workable proxy (the seed happens to number the tiers in order) but
-- only by coincidence, and the coincidence would end the first time a tier is
-- inserted out of sequence.

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
      -- The catalogue rank, so the overlay can order two gifts that cost the
      -- same — which, in free preview, is every pair of gifts.
      'sort_order',    v_tier.sort_order,
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
    'gift',
    'live:' || NEW.session_id::text,
    true
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.live_gifts_broadcast() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Every tier is free, for now
-- ---------------------------------------------------------------------------

-- FREE PREVIEW: CEO to set real prices before launch.
-- One statement per tier restores paid mode, e.g.
--   update public.gift_tiers set price_stars = 100 where slug = 'nova';
UPDATE public.gift_tiers SET price_stars = 0, updated_at = now();
