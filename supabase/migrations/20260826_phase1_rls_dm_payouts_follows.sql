-- =====================================================================
-- Phase 1 RLS — DMs, payouts, KYC, tier snapshots, follows, media.
-- Applied via Supabase MCP as `phase1_rls_dm_payouts_follows`.
--
-- payouts and creator_tier_snapshots are read-only to creators; both are
-- written by the platform (service role) only. kyc_records allows the
-- creator to file their own record but never to approve it — there is no
-- UPDATE policy, so `status` stays platform-controlled.
-- =====================================================================

-- conversations: only participants
CREATE POLICY "conversations_select_participant" ON conversations
    FOR SELECT USING (
        auth.uid() = subscriber_id
        OR creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

-- messages: only conversation participants
CREATE POLICY "messages_select_participant" ON messages
    FOR SELECT USING (
        conversation_id IN (
            SELECT id FROM conversations
            WHERE subscriber_id = auth.uid()
            OR creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
        )
    );

CREATE POLICY "messages_insert_participant" ON messages
    FOR INSERT WITH CHECK (
        sender_id = auth.uid()
        AND conversation_id IN (
            SELECT id FROM conversations
            WHERE subscriber_id = auth.uid()
            OR creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
        )
    );

-- message_purchases: buyer reads own; creator reads their unlocks
CREATE POLICY "msg_purchases_select_buyer" ON message_purchases
    FOR SELECT USING (auth.uid() = buyer_id);

CREATE POLICY "msg_purchases_select_creator" ON message_purchases
    FOR SELECT USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

-- payouts + KYC + tier snapshots (creator-only)
CREATE POLICY "payouts_select_own" ON payouts
    FOR SELECT USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

CREATE POLICY "kyc_select_own" ON kyc_records
    FOR SELECT USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

CREATE POLICY "kyc_insert_own" ON kyc_records
    FOR INSERT WITH CHECK (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

CREATE POLICY "tier_snapshots_select_own" ON creator_tier_snapshots
    FOR SELECT USING (
        creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    );

-- follows + media
CREATE POLICY "follows_select_own" ON follows
    FOR SELECT USING (auth.uid() = follower_id);

CREATE POLICY "follows_insert_own" ON follows
    FOR INSERT WITH CHECK (auth.uid() = follower_id);

CREATE POLICY "follows_delete_own" ON follows
    FOR DELETE USING (auth.uid() = follower_id);

CREATE POLICY "media_select_own" ON media_assets
    FOR SELECT USING (auth.uid() = owner_id);
