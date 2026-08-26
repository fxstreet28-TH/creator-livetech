-- =====================================================================
-- Phase 1 — Star wallet RPCs (atomic money operations)
-- Applied via Supabase MCP as `phase1_wallet_rpcs`.
--
-- Every function here is SECURITY DEFINER, pinned search_path, and
-- revoked from PUBLIC/anon/authenticated (Gate 1 decision B: all wallet
-- mutation goes through an Edge Function holding the service key).
--
-- WHY RPCs AND NOT PLAIN supabase-js CALLS
-- The requirements doc specifies deductStarsFIFO as "MUST be called
-- inside a database transaction. Uses SELECT FOR UPDATE to prevent race
-- conditions." supabase-js exposes no transaction API and cannot take
-- row locks, so the sample TypeScript cannot honour its own contract:
-- two concurrent spends read the same balance and both succeed. Moving
-- the read-modify-write into plpgsql is what makes that requirement
-- true. The exported TS signatures and return shapes are unchanged.
-- =====================================================================

-- ---------------------------------------------------------------------
-- increment_wallet_balance — as specified in Step C.2.
-- Kept as its own function (the doc names it) and called by
-- credit_stars_purchase below rather than duplicated.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION increment_wallet_balance(
    p_user_id UUID,
    p_stars INTEGER
)
RETURNS void AS $$
BEGIN
    UPDATE stars_wallet
    SET
        total_balance = total_balance + p_stars,
        total_purchased = total_purchased + p_stars,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------
-- credit_stars_purchase — one atomic unit for "user acquired Stars":
-- idempotency check, AML cap, purchase batch insert, wallet increment,
-- and the transaction log row. The sample TypeScript did these as three
-- sequential round trips, where a failure between them leaves a purchase
-- batch that the wallet aggregate does not reflect — breaking the
-- invariant total_balance = SUM(remaining_stars).
--
-- expires_at uses INTERVAL '6 months' rather than JS setMonth(+6): the
-- JS form overflows short months (Aug 31 -> Mar 3), Postgres clamps.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_stars_purchase(
    p_user_id UUID,
    p_stars INTEGER,
    p_thb NUMERIC,
    p_payment_method TEXT,
    p_payment_provider_id TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
    v_existing   star_purchases%ROWTYPE;
    v_purchase   star_purchases%ROWTYPE;
    v_balance    INTEGER;
    v_max_wallet CONSTANT INTEGER := 50000;  -- section 5.1 AML cap
BEGIN
    IF p_stars <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Amount must be positive');
    END IF;

    -- Idempotency. Unlike the sample, a row that exists but is NOT
    -- succeeded is reported rather than falling through to an INSERT that
    -- would violate idx_star_purchases_provider.
    SELECT * INTO v_existing
    FROM star_purchases
    WHERE payment_provider_id = p_payment_provider_id;

    IF FOUND THEN
        IF v_existing.payment_status = 'succeeded' THEN
            SELECT total_balance INTO v_balance FROM stars_wallet WHERE user_id = v_existing.user_id;
            RETURN jsonb_build_object(
                'success', true, 'idempotent_replay', true,
                'purchase_id', v_existing.id,
                'new_wallet_balance', v_balance,
                'expires_at', v_existing.expires_at
            );
        END IF;
        RETURN jsonb_build_object(
            'success', false,
            'error', format('payment_provider_id %s already exists with status %s',
                            p_payment_provider_id, v_existing.payment_status)
        );
    END IF;

    -- Lock the wallet before reading the balance the cap is checked against.
    SELECT total_balance INTO v_balance
    FROM stars_wallet WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Wallet not found');
    END IF;

    IF v_balance + p_stars > v_max_wallet THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', format('Wallet cap exceeded: balance %s + %s would exceed the %s Star limit',
                            v_balance, p_stars, v_max_wallet)
        );
    END IF;

    INSERT INTO star_purchases (
        user_id, stars_amount, thb_amount, payment_method, payment_provider_id,
        payment_status, expires_at, remaining_stars, metadata, completed_at
    ) VALUES (
        p_user_id, p_stars, p_thb, p_payment_method, p_payment_provider_id,
        'succeeded', NOW() + INTERVAL '6 months', p_stars,
        COALESCE(p_metadata, '{}'::jsonb), NOW()
    )
    RETURNING * INTO v_purchase;

    PERFORM increment_wallet_balance(p_user_id, p_stars);

    INSERT INTO star_transactions (
        user_id, transaction_type, stars_delta, reference_id, reference_type, purchase_batch_ids
    ) VALUES (
        p_user_id, 'purchase', p_stars, v_purchase.id, 'star_purchase', ARRAY[v_purchase.id]
    );

    SELECT total_balance INTO v_balance FROM stars_wallet WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true, 'idempotent_replay', false,
        'purchase_id', v_purchase.id,
        'new_wallet_balance', v_balance,
        'expires_at', v_purchase.expires_at
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------
-- deduct_stars_fifo — the atomic core of deductStarsFIFO().
-- Locks the wallet row, then the live batches in expiry order, so
-- concurrent spends serialise instead of both reading a stale balance.
-- Lock order (wallet, then batches) is uniform across every function
-- here, so these cannot deadlock against each other.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION deduct_stars_fifo(
    p_user_id UUID,
    p_stars INTEGER,
    p_transaction_type TEXT DEFAULT 'ppv_unlock',
    p_reference_id UUID DEFAULT NULL,
    p_reference_type TEXT DEFAULT NULL,
    p_creator_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_balance   INTEGER;
    v_remaining INTEGER := p_stars;
    v_take      INTEGER;
    v_batch     RECORD;
    v_deducted  JSONB := '[]'::jsonb;
    v_batch_ids UUID[] := ARRAY[]::UUID[];
BEGIN
    IF p_stars <= 0 THEN
        RETURN jsonb_build_object('success', false, 'deducted_from_batches', '[]'::jsonb,
                                  'new_wallet_balance', 0, 'error', 'Amount must be positive');
    END IF;

    SELECT total_balance INTO v_balance
    FROM stars_wallet WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'deducted_from_batches', '[]'::jsonb,
                                  'new_wallet_balance', 0, 'error', 'Wallet not found');
    END IF;

    IF v_balance < p_stars THEN
        RETURN jsonb_build_object('success', false, 'deducted_from_batches', '[]'::jsonb,
                                  'new_wallet_balance', v_balance,
                                  'error', format('Insufficient balance. Have %s, need %s', v_balance, p_stars));
    END IF;

    FOR v_batch IN
        SELECT id, remaining_stars
        FROM star_purchases
        WHERE user_id = p_user_id
          AND remaining_stars > 0
          AND expires_at > NOW()
        ORDER BY expires_at ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining = 0;

        v_take := LEAST(v_batch.remaining_stars, v_remaining);

        UPDATE star_purchases
        SET remaining_stars = remaining_stars - v_take
        WHERE id = v_batch.id;

        v_deducted := v_deducted || jsonb_build_object('purchase_id', v_batch.id, 'stars', v_take);
        v_batch_ids := v_batch_ids || v_batch.id;
        v_remaining := v_remaining - v_take;
    END LOOP;

    -- Balance covered the spend but the live batches did not: the wallet
    -- aggregate has drifted from SUM(remaining_stars), or stock expired
    -- without the cron reconciling it. Abort rather than half-spend.
    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'wallet_drift: balance % covers % stars but only % were available in unexpired batches',
              v_balance, p_stars, p_stars - v_remaining;
    END IF;

    UPDATE stars_wallet
    SET total_balance = total_balance - p_stars,
        total_spent   = total_spent + p_stars,   -- lifetime counter, not a delta overwrite
        updated_at    = NOW()
    WHERE user_id = p_user_id;

    INSERT INTO star_transactions (
        user_id, transaction_type, stars_delta, reference_id, reference_type,
        creator_id, purchase_batch_ids
    ) VALUES (
        p_user_id, p_transaction_type, -p_stars, p_reference_id, p_reference_type,
        p_creator_id, v_batch_ids
    );

    RETURN jsonb_build_object(
        'success', true,
        'deducted_from_batches', v_deducted,
        'new_wallet_balance', v_balance - p_stars
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------
-- expire_star_batches — section 8.10 step 3, as one atomic pass.
-- Each batch's zeroing, wallet adjustment and ledger row must land
-- together or the invariant breaks, so this is not done row-by-row from
-- TypeScript. Returns the per-batch detail the cron needs to write
-- notifications.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_star_batches()
RETURNS JSONB AS $$
DECLARE
    v_batch  RECORD;
    v_out    JSONB := '[]'::jsonb;
    v_count  INTEGER := 0;
    v_total  INTEGER := 0;
BEGIN
    FOR v_batch IN
        SELECT id, user_id, remaining_stars
        FROM star_purchases
        WHERE expires_at <= NOW()
          AND remaining_stars > 0
        ORDER BY user_id, expires_at
        FOR UPDATE
    LOOP
        UPDATE star_purchases SET remaining_stars = 0 WHERE id = v_batch.id;

        UPDATE stars_wallet
        SET total_balance = GREATEST(total_balance - v_batch.remaining_stars, 0),
            total_expired = total_expired + v_batch.remaining_stars,
            updated_at    = NOW()
        WHERE user_id = v_batch.user_id;

        INSERT INTO star_transactions (
            user_id, transaction_type, stars_delta, reference_id, reference_type, purchase_batch_ids
        ) VALUES (
            v_batch.user_id, 'expiration', -v_batch.remaining_stars,
            v_batch.id, 'star_purchase', ARRAY[v_batch.id]
        );

        v_out := v_out || jsonb_build_object(
            'purchase_id', v_batch.id,
            'user_id', v_batch.user_id,
            'stars_expired', v_batch.remaining_stars
        );
        v_count := v_count + 1;
        v_total := v_total + v_batch.remaining_stars;
    END LOOP;

    RETURN jsonb_build_object('batches_expired', v_count, 'stars_expired_total', v_total, 'detail', v_out);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------
-- Grants. REVOKE targets PUBLIC because Postgres grants EXECUTE on every
-- new function to PUBLIC by default — granting to service_role alone
-- would leave anon and authenticated able to call these.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION increment_wallet_balance(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION credit_stars_purchase(UUID, INTEGER, NUMERIC, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION deduct_stars_fifo(UUID, INTEGER, TEXT, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION expire_star_batches() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION increment_wallet_balance(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION credit_stars_purchase(UUID, INTEGER, NUMERIC, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION deduct_stars_fifo(UUID, INTEGER, TEXT, UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION expire_star_batches() TO service_role;
