-- =====================================================================
-- Revoke client EXECUTE on the Phase A wallet trigger function.
-- Applied via Supabase MCP as `revoke_wallet_trigger_fn_from_clients`.
--
-- Por's Gate 1 decision (B): no user-callable wallet-mutating RPC —
-- every wallet mutation goes through an Edge Function holding the
-- service key.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, which
-- is what exposed create_wallet_for_new_user() at /rest/v1/rpc/ and
-- raised the anon/authenticated SECURITY DEFINER advisories. Revoking
-- from PUBLIC is what actually removes it — revoking from anon and
-- authenticated alone would leave the PUBLIC grant standing.
--
-- The trigger is unaffected: EXECUTE on a trigger function is checked
-- when CREATE TRIGGER runs, not on each fire. Verified after applying by
-- inserting an auth.users row in a rolled-back transaction and reading
-- back the wallet it created (has_function_privilege false for both
-- client roles, wallet still created at balance 0).
--
-- The same treatment is applied to increment_wallet_balance() when
-- Phase C creates it.
-- =====================================================================

REVOKE ALL ON FUNCTION public.create_wallet_for_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_wallet_for_new_user() FROM anon;
REVOKE ALL ON FUNCTION public.create_wallet_for_new_user() FROM authenticated;
