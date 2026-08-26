-- =====================================================================
-- Phase E — run_star_expiration_cycle(), the whole § 8.10 daily job.
-- Applied via Supabase MCP as `phase1_star_expiration_cycle`.
--
-- Single source of truth for the cycle: the cron-star-expirations Edge
-- Function calls this, and so does the pg_cron schedule. Putting the
-- logic here rather than in TypeScript is what lets pg_cron run it
-- directly and avoid the spec'd pg_net round trip (see
-- 20260826_enable_pg_cron_and_schedule.sql for that rationale).
--
-- Idempotent: notification inserts are ON CONFLICT DO NOTHING against
-- idx_notifications_dedupe, and expire_star_batches() only ever sees
-- batches that still have remaining_stars > 0.
-- =====================================================================

CREATE OR REPLACE FUNCTION run_star_expiration_cycle()
RETURNS JSONB AS $$
DECLARE
    rec             RECORD;
    v_expired       JSONB;
    v_detail        JSONB;
    v_notifs        INTEGER := 0;
    v_expiry_notifs INTEGER := 0;
    v_title         TEXT;
    v_body          TEXT;
    v_type          TEXT;
    v_days          INTEGER;
BEGIN
    -- 1. Upcoming-expiry notifications at the § 5.1 thresholds.
    FOR rec IN
        SELECT p.id, p.user_id, p.remaining_stars, p.expires_at,
               EXTRACT(DAY FROM (p.expires_at - NOW()))::INTEGER AS days_until_expiry
        FROM star_purchases p
        WHERE p.remaining_stars > 0
          AND p.expires_at > NOW()
    LOOP
        v_days := rec.days_until_expiry;
        IF v_days NOT IN (30, 14, 7, 1) THEN
            CONTINUE;
        END IF;

        v_type := format('stars_expiring_%sd', v_days);

        -- Copy follows § 5.1's notification schedule wording.
        IF v_days = 30 THEN
            v_title := 'Stars expiring in 30 days';
            v_body  := format('You have %s Stars expiring in 30 days', rec.remaining_stars);
        ELSIF v_days = 14 THEN
            v_title := 'Stars expiring in 14 days';
            v_body  := format('Reminder: %s Stars expire in 14 days', rec.remaining_stars);
        ELSIF v_days = 7 THEN
            v_title := 'Stars expiring in 7 days';
            v_body  := format('Last week: %s Stars expire in 7 days', rec.remaining_stars);
        ELSE
            v_title := 'Stars expire tomorrow';
            v_body  := format('TODAY: %s Stars expire tomorrow', rec.remaining_stars);
        END IF;

        INSERT INTO notifications (user_id, type, title, body, reference_id, reference_type)
        VALUES (rec.user_id, v_type, v_title, v_body, rec.id, 'star_purchase')
        ON CONFLICT DO NOTHING;

        IF FOUND THEN
            v_notifs := v_notifs + 1;
        END IF;
    END LOOP;

    -- 2. Actual expiration (atomic per batch inside expire_star_batches).
    v_expired := expire_star_batches();

    -- 3. One "expired" notification per batch that just lapsed.
    FOR v_detail IN SELECT * FROM jsonb_array_elements(v_expired->'detail')
    LOOP
        INSERT INTO notifications (user_id, type, title, body, reference_id, reference_type)
        VALUES (
            (v_detail->>'user_id')::UUID,
            'stars_expired',
            'Stars expired',
            format('%s Stars have expired', v_detail->>'stars_expired'),
            (v_detail->>'purchase_id')::UUID,
            'star_purchase'
        )
        ON CONFLICT DO NOTHING;

        IF FOUND THEN
            v_expiry_notifs := v_expiry_notifs + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'notifications_created', v_notifs + v_expiry_notifs,
        'expiring_soon_notifications', v_notifs,
        'expired_notifications', v_expiry_notifs,
        'batches_expired', (v_expired->>'batches_expired')::INTEGER,
        'stars_expired_total', (v_expired->>'stars_expired_total')::INTEGER,
        'ran_at', NOW()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION run_star_expiration_cycle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION run_star_expiration_cycle() TO service_role;
