-- =====================================================================
-- Phase 1 — enable RLS on all 18 new tables.
-- Applied via Supabase MCP as `phase1_enable_rls`.
--
-- Enabling RLS with no policies denies everything to anon/authenticated;
-- the policy migrations that follow in this same commit grant back the
-- intended reads and writes. The service role bypasses RLS throughout,
-- which is how the Phase C/D/E Edge Functions will write.
-- =====================================================================

ALTER TABLE creator_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ppv_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ppv_unlocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE stars_wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE star_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE star_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE star_buybacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_tier_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE follows ENABLE ROW LEVEL SECURITY;
