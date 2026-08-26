-- =====================================================================
-- Phase 1 RLS — creator profiles and subscription plans.
-- Applied via Supabase MCP as `phase1_rls_creators_and_plans`.
--
-- The `creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())`
-- shape recurs throughout Phase 1. It works because public.creators
-- carries its own "Users can read their own creator row" SELECT policy
-- (auth.uid() = user_id) — RLS applies to tables referenced inside a
-- policy subquery too, so without that policy every one of these would
-- silently evaluate to false. Verified before applying.
-- =====================================================================

-- creator_profiles: everyone reads public; owner writes
CREATE POLICY "creator_profiles_select_public" ON creator_profiles
    FOR SELECT USING (is_public = true);

CREATE POLICY "creator_profiles_select_own" ON creator_profiles
    FOR SELECT USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

CREATE POLICY "creator_profiles_update_own" ON creator_profiles
    FOR UPDATE USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

-- subscription_plans: everyone reads active; creator owns
CREATE POLICY "plans_select_active" ON subscription_plans
    FOR SELECT USING (is_active = true);

CREATE POLICY "plans_manage_own" ON subscription_plans
    FOR ALL USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );
