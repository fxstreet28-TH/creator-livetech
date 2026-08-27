-- =====================================================================
-- AURUM Live — Week 3: Stripe PromptPay star purchases + buyback
-- Project: hknvooaqgpufrbdxtzxf (Aurumtech, ap-southeast-2)
--
-- Adds the schema the three new Edge Functions run on:
--   star_pricing_config    versioned retail price, exactly one row live
--   star_payment_intents   Stripe PaymentIntents in flight (pending state)
--   stripe_events          webhook idempotency + audit ledger
--   buyback_requests       user-initiated cashout at a fixed 3.00 THB/star
--   request_buyback()      atomic star deduction + request row
--
-- Plus two adjustments to the Phase 1 star tables that Week 3 needs:
-- a wider purchase size range, and a retail price per star recorded on
-- every batch.
--
-- Applied via Supabase MCP apply_migration as `week3_stripe_promptpay`.
-- Table order is FK-dependency order; do not reorder.
-- =====================================================================


-- ---------------------------------------------------------------------
-- star_pricing_config — what a star retails for right now.
--
-- Versioned rather than a constant so a promo or flash sale is a row
-- insert, not a redeploy. internal_thb_per_star stays pinned at 10.00 by
-- CHECK: it is the creator-facing settlement value the whole Star economy
-- is denominated in (§ 5.1), and the retail markup above it is the only
-- chargeback/refund buffer the Option D policy carries. Letting it drift
-- would silently repriced every creator payout, so the constraint makes
-- that impossible without a migration.
--
-- retail is bounded 10.00-20.00: below 10.00 the platform sells stars at
-- a loss against the internal value, above 20.00 is a fat-finger.
-- ---------------------------------------------------------------------
CREATE TABLE public.star_pricing_config (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    retail_thb_per_star   NUMERIC(5,2) NOT NULL
                            CHECK (retail_thb_per_star >= 10.00 AND retail_thb_per_star <= 20.00),
    internal_thb_per_star NUMERIC(5,2) NOT NULL DEFAULT 10.00
                            CHECK (internal_thb_per_star = 10.00),
    label                 TEXT NOT NULL,          -- 'launch_regular' | 'flash_sale' | ...
    is_active             BOOLEAN NOT NULL DEFAULT false,
    valid_from            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_to              TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by            UUID REFERENCES auth.users(id),
    notes                 TEXT
);

-- At most one live price. A partial unique index on a boolean is the
-- cheapest way to say that: two rows with is_active = true collide, rows
-- with false are unconstrained. Switching price is therefore a single
-- transaction that flips the old row off and the new one on — there is no
-- window in which create-payment-intent could read two prices, and none
-- in which it could read none if the flip is done in one statement pair.
CREATE UNIQUE INDEX star_pricing_config_only_one_active
    ON public.star_pricing_config (is_active)
    WHERE is_active = true;

CREATE INDEX star_pricing_config_valid_from_idx
    ON public.star_pricing_config (valid_from DESC);

INSERT INTO public.star_pricing_config (retail_thb_per_star, label, is_active, notes)
VALUES (11.00, 'launch_regular', true, 'Launch phase Month 1-3 per Aug 26 decision');

ALTER TABLE public.star_pricing_config ENABLE ROW LEVEL SECURITY;

-- The buy screen has to render a price, so the live row is readable by any
-- signed-in user. Superseded rows are not: the price history is internal.
CREATE POLICY star_pricing_read_active ON public.star_pricing_config
    FOR SELECT TO authenticated
    USING (is_active = true);

-- No write policies. The blanket grants Supabase puts on new public tables
-- are revoked as well, so a future policy added by mistake still cannot
-- turn into a write path for a client.
REVOKE INSERT, UPDATE, DELETE ON public.star_pricing_config FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- star_purchases adjustments.
--
-- 1. Purchase bounds. Phase 1 pinned stars_amount to 100-10000 from
--    § 5.1. Week 3 sells from 10 stars (110 THB, the smallest amount worth
--    a PromptPay QR, and what Gate 2 buys) up to 100000. The wallet is
--    still capped at 50000 stars by credit_stars_purchase's AML check, so
--    the upper bound here is a ceiling on a single intent, not on what can
--    actually be held; create-payment-intent rejects a purchase that would
--    breach the wallet cap before Stripe ever sees it, so nobody can pay
--    for stars the credit path would then refuse.
--
-- 2. retail_thb_per_star. Every batch needs to record what the buyer
--    actually paid per star, so the markup over the 10.00 internal value
--    is auditable per purchase rather than inferred from the pricing
--    config live at the time. Computed rather than stored-and-hoped:
--    thb_amount / stars_amount *is* the retail price, so a generated
--    column cannot drift from the money, and credit_stars_purchase needs
--    no change to populate it.
-- ---------------------------------------------------------------------
ALTER TABLE public.star_purchases
    DROP CONSTRAINT star_purchases_stars_amount_check;

ALTER TABLE public.star_purchases
    ADD CONSTRAINT star_purchases_stars_amount_check
    CHECK (stars_amount >= 10 AND stars_amount <= 100000);

ALTER TABLE public.star_purchases
    ADD COLUMN retail_thb_per_star NUMERIC(5,2)
    GENERATED ALWAYS AS (ROUND(thb_amount / NULLIF(stars_amount, 0), 2)) STORED;

COMMENT ON COLUMN public.star_purchases.retail_thb_per_star IS
    'THB the buyer paid per star for this batch. Derived from thb_amount / stars_amount, so it cannot disagree with the money. Compare against the 10.00 internal value for the markup.';


-- ---------------------------------------------------------------------
-- star_payment_intents — Stripe PaymentIntents that have not been paid.
--
-- DEVIATION from the Week 3 spec, which had create-payment-intent write a
-- star_purchases row with status 'pending'. It cannot: star_purchases is
-- the FIFO batch table, and credit_stars_purchase treats an existing row
-- on the same payment_provider_id in a non-succeeded state as a hard error
-- rather than something to upgrade. A pending row keyed on the
-- PaymentIntent id would therefore make the webhook's credit call fail on
-- every real payment. It would also break the Phase 1 invariant
-- (stars_wallet.total_balance = SUM(star_purchases.remaining_stars)) for
-- as long as the row sat unpaid, and hand expire_star_batches a batch with
-- no meaningful expires_at.
--
-- So the in-flight state lives here, and star_purchases keeps its
-- Phase 1 meaning: a row exists only for money actually received. The
-- webhook links the two with star_purchase_id once the credit lands.
-- ---------------------------------------------------------------------
CREATE TABLE public.star_payment_intents (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_payment_intent_id TEXT UNIQUE NOT NULL,
    user_id                  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stars                    INTEGER NOT NULL CHECK (stars >= 10 AND stars <= 100000),
    retail_thb_per_star      NUMERIC(5,2) NOT NULL,
    internal_thb_per_star    NUMERIC(5,2) NOT NULL DEFAULT 10.00,
    amount_thb               NUMERIC(10,2) NOT NULL,
    amount_satang            BIGINT NOT NULL,       -- what Stripe was actually charged, in minor units
    currency                 TEXT NOT NULL DEFAULT 'thb',
    pricing_config_id        UUID REFERENCES public.star_pricing_config(id),
    source                   TEXT NOT NULL DEFAULT 'custom'
                               CHECK (source IN ('preset', 'custom')),
    status                   TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
    stripe_charge_id         TEXT,
    failure_reason           TEXT,
    star_purchase_id         UUID REFERENCES public.star_purchases(id),  -- set on credit
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at                  TIMESTAMPTZ
);

CREATE INDEX star_payment_intents_user_idx
    ON public.star_payment_intents (user_id, created_at DESC);
CREATE INDEX star_payment_intents_pending_idx
    ON public.star_payment_intents (created_at DESC) WHERE status = 'pending';

ALTER TABLE public.star_payment_intents ENABLE ROW LEVEL SECURITY;

-- A buyer may watch their own intent (the buy screen polls it while the QR
-- is on screen). Only the webhook, on the service key, writes.
CREATE POLICY star_payment_intents_read_own ON public.star_payment_intents
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON public.star_payment_intents FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- stripe_events — every webhook delivery, exactly once.
--
-- event_id is Stripe's own event id and the primary key, which is what
-- makes the webhook idempotent: the handler inserts here before doing any
-- work, and a 23505 means a duplicate delivery that has already been
-- handled. Stripe retries aggressively on 5xx and can deliver the same
-- event more than once even on success, so this is the difference between
-- crediting stars once and crediting them twice.
--
-- payload keeps the full event for audit and for the fraud-pattern work
-- the Option D policy defers to later — PromptPay cannot be charged back,
-- but abuse patterns still need somewhere to be visible from.
-- ---------------------------------------------------------------------
CREATE TABLE public.stripe_events (
    event_id          TEXT PRIMARY KEY,      -- 'evt_1ABC...'
    event_type        TEXT NOT NULL,         -- 'payment_intent.succeeded' | ...
    livemode          BOOLEAN NOT NULL,
    processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload           JSONB NOT NULL,
    processing_result JSONB,
    processing_status TEXT NOT NULL DEFAULT 'received'
                        CHECK (processing_status IN ('received', 'processed', 'failed', 'ignored'))
);

CREATE INDEX stripe_events_type_time_idx
    ON public.stripe_events (event_type, processed_at DESC);

ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

-- No policies: service_role only. The blanket table grants are revoked
-- outright here rather than left to RLS, because payload holds raw Stripe
-- event bodies — buyer ids, amounts, charge ids — and nothing client-side
-- has any business reading them.
REVOKE ALL ON public.stripe_events FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- buyback_requests — the only exit from stars, at a fixed 3.00 THB/star.
--
-- Zero-refund policy: a PromptPay payment is a push payment and cannot be
-- reversed by the payer's bank, so there is no refund path and no
-- chargeback handler anywhere in this migration. Buyback is it.
--
-- thb_per_star is pinned by CHECK rather than read from config: the
-- buyback rate is a policy commitment, not a price, and a config-driven
-- rate is one UPDATE away from paying out at retail.
--
-- Payout itself is manual in Phase 2 — a row lands here as 'pending' and
-- an admin moves it on. Nothing in this PR pays anyone.
--
-- Supersedes star_buybacks (Phase 1, never written to): that table's
-- 100-star floor and payout_method/payout_details shape predate the
-- 10-star floor and the bank-transfer-only decision. It is left in place
-- rather than dropped so this migration stays reversible; it can go in a
-- later cleanup once nothing references it.
-- ---------------------------------------------------------------------
CREATE TABLE public.buyback_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id),
    star_amount         INTEGER NOT NULL CHECK (star_amount >= 10),
    thb_per_star        NUMERIC(5,2) NOT NULL DEFAULT 3.00 CHECK (thb_per_star = 3.00),
    total_thb           NUMERIC(10,2) NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'paid', 'rejected', 'cancelled')),
    bank_name           TEXT,
    bank_account_number TEXT,
    bank_account_name   TEXT,
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at        TIMESTAMPTZ,
    processed_by        UUID REFERENCES auth.users(id),
    admin_notes         TEXT,
    rejection_reason    TEXT
);

CREATE INDEX buyback_requests_user_status_idx
    ON public.buyback_requests (user_id, status, requested_at DESC);
CREATE INDEX buyback_requests_pending_idx
    ON public.buyback_requests (requested_at DESC) WHERE status = 'pending';

ALTER TABLE public.buyback_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY buyback_read_own ON public.buyback_requests
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- No write policies: every insert goes through request_buyback() below, so
-- the star deduction and the request row can never come apart.
REVOKE INSERT, UPDATE, DELETE ON public.buyback_requests FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- request_buyback — deduct the stars and record the request, atomically.
--
-- Order matters: the request row is inserted first so its id can be the
-- deduction's reference_id, then deduct_stars_fifo runs. Both are in this
-- function's transaction, so a failed deduction takes the request row with
-- it — there is no path to a pending payout for stars the user still
-- holds.
--
-- deduct_stars_fifo reports business failures in its return value rather
-- than by raising, so the result is inspected explicitly. PERFORMing it
-- and moving on would create exactly the request-without-deduction the
-- ordering above exists to prevent.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_buyback(
    p_user_id             UUID,
    p_star_amount         INTEGER,
    p_bank_name           TEXT,
    p_bank_account_number TEXT,
    p_bank_account_name   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_balance    INTEGER;
    v_total_thb  NUMERIC(10,2);
    v_request_id UUID;
    v_deduction  JSONB;
    v_rate CONSTANT NUMERIC(5,2) := 3.00;   -- policy, not config. See table comment.
BEGIN
    IF p_star_amount IS NULL OR p_star_amount < 10 THEN
        RAISE EXCEPTION 'below_minimum' USING ERRCODE = 'P0001';
    END IF;

    -- Lock the wallet before reading the balance the check is made against,
    -- so two concurrent requests cannot both pass it. deduct_stars_fifo
    -- takes the same lock in the same order later in this transaction,
    -- which is already held by then.
    SELECT total_balance INTO v_balance
    FROM public.stars_wallet
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'wallet_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF v_balance < p_star_amount THEN
        RAISE EXCEPTION 'insufficient_stars' USING ERRCODE = 'P0001';
    END IF;

    v_total_thb := p_star_amount * v_rate;

    INSERT INTO public.buyback_requests (
        user_id, star_amount, thb_per_star, total_thb,
        bank_name, bank_account_number, bank_account_name
    ) VALUES (
        p_user_id, p_star_amount, v_rate, v_total_thb,
        p_bank_name, p_bank_account_number, p_bank_account_name
    ) RETURNING id INTO v_request_id;

    v_deduction := public.deduct_stars_fifo(
        p_user_id,
        p_star_amount,
        'buyback',
        v_request_id,
        'buyback_request',
        NULL
    );

    IF COALESCE((v_deduction ->> 'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'deduction_failed: %', COALESCE(v_deduction ->> 'error', 'unknown')
            USING ERRCODE = 'P0001';
    END IF;

    -- deduct_stars_fifo books every deduction as lifetime spend, which is
    -- right for a spend and wrong for a cashout: stars sold back were never
    -- spent on a creator. Move the counter across so total_spent stays a
    -- true picture of what flowed to creators and total_bought_back a true
    -- picture of what left as THB. total_balance is already correct.
    UPDATE public.stars_wallet
    SET total_spent       = total_spent - p_star_amount,
        total_bought_back = total_bought_back + p_star_amount,
        updated_at        = NOW()
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'request_id', v_request_id,
        'star_amount', p_star_amount,
        'total_thb', v_total_thb,
        'thb_per_star', v_rate,
        'status', 'pending',
        'new_wallet_balance', v_deduction -> 'new_wallet_balance'
    );
END;
$$;

-- Same lockdown as every other money RPC: the service key, held only by
-- Edge Functions, is the sole caller. REVOKE names PUBLIC because Postgres
-- grants EXECUTE on new functions to PUBLIC by default.
REVOKE ALL ON FUNCTION public.request_buyback(UUID, INTEGER, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_buyback(UUID, INTEGER, TEXT, TEXT, TEXT)
    TO service_role;
