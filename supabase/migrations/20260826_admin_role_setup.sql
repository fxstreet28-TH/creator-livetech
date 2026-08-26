-- =====================================================================
-- Phase D — admin allow-list (hardcoded for MVP, per Step D.1).
-- Applied via Supabase MCP as `admin_role_setup`.
-- =====================================================================

CREATE OR REPLACE FUNCTION is_admin(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN p_user_id IN (
        SELECT id FROM auth.users WHERE email IN (
            'porforex599@gmail.com',
            'aurumtech@outlook.co.th'
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Resolve a target user by email for the admin credit endpoint.
-- auth.users is not exposed through PostgREST, so the lookup needs a
-- SECURITY DEFINER hop rather than a direct query from the function.
CREATE OR REPLACE FUNCTION admin_find_user_by_email(p_email TEXT)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    SELECT id INTO v_id FROM auth.users WHERE lower(email) = lower(trim(p_email));
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- DEVIATION from Step D.1, which specifies
--   GRANT EXECUTE ON FUNCTION is_admin TO authenticated, service_role;
--
-- authenticated is dropped. The only caller is admin-credit-stars, which
-- holds the service key, so the grant buys nothing — and is_admin() takes
-- an arbitrary UUID and returns a boolean, so exposing it at
-- /rest/v1/rpc/is_admin hands any signed-in user an oracle for
-- enumerating which accounts are admins. Same principle as Gate 1
-- decision (B). Restore the authenticated grant if a client ever needs to
-- render admin-only UI.
REVOKE ALL ON FUNCTION is_admin(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admin_find_user_by_email(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION is_admin(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION admin_find_user_by_email(TEXT) TO service_role;
