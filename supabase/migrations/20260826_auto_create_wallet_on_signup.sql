-- =====================================================================
-- AURUM Live — auto-create a Star wallet for every new user
-- Project: hknvooaqgpufrbdxtzxf
--
-- Applied via Supabase MCP apply_migration as `auto_create_wallet_on_signup`,
-- followed by a one-off backfill for the 5 pre-existing users (see below).
--
-- Deviation from fanvue-phase1-requirements.md Step A.3: the function body
-- gains `SET search_path = public`. The trigger fires inside GoTrue's
-- auth.admin.createUser transaction, where an unqualified `stars_wallet`
-- that failed to resolve would abort user creation and break signup
-- outright. Pinning search_path makes resolution independent of the
-- caller's setting, and also closes Supabase's mutable-search_path
-- advisor on a SECURITY DEFINER function. No behavioural change.
-- =====================================================================

CREATE OR REPLACE FUNCTION create_wallet_for_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO stars_wallet (user_id, total_balance)
    VALUES (NEW.id, 0)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created_create_wallet
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION create_wallet_for_new_user();

-- Backfill for users that predate the trigger. Run once, after the trigger
-- exists; idempotent, so re-running is harmless.
--
--   INSERT INTO stars_wallet (user_id, total_balance)
--   SELECT id, 0 FROM auth.users
--   ON CONFLICT (user_id) DO NOTHING;
