-- =====================================================================
-- AURUM Live — Week 3 frontend: stream stars_wallet over Realtime
-- Project: hknvooaqgpufrbdxtzxf (Aurumtech, ap-southeast-2)
--
-- The buy screen learns that a PromptPay payment landed by subscribing to
-- UPDATEs on its own stars_wallet row: the buyer scans the QR in their bank
-- app, Stripe calls stripe-webhook, credit_stars_purchase raises
-- total_balance, and the screen flips to its success state off that event.
--
-- That subscription needs the table in the supabase_realtime publication.
-- The publication exists on this project but was created empty
-- (puballtables = false, zero member tables), so without this migration the
-- channel subscribes successfully and then never delivers a payload —
-- a silent failure, not an error. Every purchase would sit on the QR until
-- the 60-second fallback offered a manual refresh button, which is the
-- degraded path, not the design.
--
-- Only stars_wallet is added. star_payment_intents would be the other
-- candidate — it carries the pending/succeeded status — but the balance is
-- what the success state actually reports, and a second streamed table is
-- more WAL traffic for a fact the first one already establishes.
--
-- Safety: publication membership is not a grant. Realtime evaluates RLS per
-- subscriber before delivering a postgres_changes payload, so a client can
-- only receive rows wallet_select_own already lets it SELECT — its own.
-- Adding the table widens nobody's read access.
--
-- REPLICA IDENTITY is left at DEFAULT (primary key). UPDATE payloads carry
-- the full new row regardless, which is all the buy screen reads
-- (payload.new.total_balance); FULL would only add the old row, at the cost
-- of writing every column of every wallet update into the WAL.
--
-- Reversible: ALTER PUBLICATION supabase_realtime DROP TABLE public.stars_wallet;
--
-- Applied via Supabase MCP as `week3_realtime_stars_wallet`.
-- =====================================================================

DO $$
BEGIN
    -- Idempotent: re-adding a member table raises 42710, and this migration
    -- must be safe to replay against a project where it has already run.
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'stars_wallet'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.stars_wallet;
    END IF;
END
$$;
