-- =====================================================================
-- Phase 1 RLS — subscriptions, PPV posts/unlocks, feed.
-- Applied via Supabase MCP as `phase1_rls_subscriptions_ppv_feed`.
--
-- KNOWN GAP, applied as specified and reported at the Phase B gate:
-- `subs_update_cancel_own` is commented "update auto_renew only", but a
-- USING/WITH CHECK pair cannot scope an UPDATE to one column. As written
-- a subscriber may rewrite ANY column of their own subscription row —
-- proven in test by self-extending expires_at to 2036 and setting
-- price_stars to 0. Nothing writes this table until Week 5-6, so it is
-- not yet exploitable. Suggested fix, pending Por's approval:
--   REVOKE UPDATE ON subscriptions FROM authenticated;
--   GRANT  UPDATE (auto_renew) ON subscriptions TO authenticated;
-- =====================================================================

-- subscriptions: subscriber reads own; creator reads their subscribers
CREATE POLICY "subs_select_own_as_subscriber" ON subscriptions
    FOR SELECT USING (auth.uid() = subscriber_id);

CREATE POLICY "subs_select_own_as_creator" ON subscriptions
    FOR SELECT USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

-- subscriber can cancel own subscription (update auto_renew only)
CREATE POLICY "subs_update_cancel_own" ON subscriptions
    FOR UPDATE USING (auth.uid() = subscriber_id)
    WITH CHECK (auth.uid() = subscriber_id);

-- ppv_posts: everyone reads published; creator manages
CREATE POLICY "ppv_posts_select_published" ON ppv_posts
    FOR SELECT USING (is_published = true);

CREATE POLICY "ppv_posts_manage_own" ON ppv_posts
    FOR ALL USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

-- ppv_unlocks: subscriber reads own; creator reads their unlocks
CREATE POLICY "unlocks_select_own_as_subscriber" ON ppv_unlocks
    FOR SELECT USING (auth.uid() = subscriber_id);

CREATE POLICY "unlocks_select_own_as_creator" ON ppv_unlocks
    FOR SELECT USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

-- feed_posts: public posts visible to all; subscription-only to subscribers
CREATE POLICY "feed_select_public" ON feed_posts
    FOR SELECT USING (access_level = 'public');

CREATE POLICY "feed_select_subscriber" ON feed_posts
    FOR SELECT USING (
        access_level = 'subscriber_only'
        AND creator_id IN (
            SELECT creator_id FROM subscriptions
            WHERE subscriber_id = auth.uid()
            AND status = 'active'
            AND expires_at > NOW()
        )
    );

CREATE POLICY "feed_manage_own" ON feed_posts
    FOR ALL USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );
