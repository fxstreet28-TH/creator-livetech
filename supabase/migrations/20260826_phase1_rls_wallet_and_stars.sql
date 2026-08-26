-- =====================================================================
-- Phase 1 RLS — wallet and Star ledger tables.
-- Applied via Supabase MCP as `phase1_rls_wallet_and_stars`.
--
-- Read-only for users across the board. stars_wallet deliberately has no
-- INSERT and no UPDATE policy: the only writers are the SECURITY DEFINER
-- signup trigger and the service-role helpers in _shared/stars.ts. A user
-- cannot mint, move or zero their own balance — verified by test.
-- =====================================================================

-- stars_wallet: user reads own only
CREATE POLICY "wallet_select_own" ON stars_wallet
    FOR SELECT USING (auth.uid() = user_id);

-- star_purchases: user reads own
CREATE POLICY "purchases_select_own" ON star_purchases
    FOR SELECT USING (auth.uid() = user_id);

-- star_transactions: user reads own
CREATE POLICY "transactions_select_own" ON star_transactions
    FOR SELECT USING (auth.uid() = user_id);

-- star_buybacks: user reads + inserts own (with status='pending' only)
CREATE POLICY "buybacks_select_own" ON star_buybacks
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "buybacks_insert_own_pending" ON star_buybacks
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        AND status = 'pending'
    );
