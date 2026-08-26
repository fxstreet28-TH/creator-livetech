import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role client. Bypasses RLS. Only for server-side operations that
 * legitimately need to write cross-user data (creating auth.users, inserting
 * into customers on behalf of signup).
 *
 * Anon-key client operations should be done from the browser — do not
 * proxy them through Edge Functions unless there's a specific reason.
 */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Anon-key client. Port of lib/supabase-server.ts getAnonSupabase().
 *
 * Used by complete-signup for exactly one thing: signing a freshly created user
 * in with signInWithPassword so the function can hand back real session tokens.
 * The service-role client cannot do that — a service-role sign-in would not
 * produce a user-scoped session.
 *
 * Not cached, for the same reason the Node original is not: one sign-in per
 * request, and no shared auth state between them.
 *
 * SUPABASE_ANON_KEY is injected by the Edge runtime alongside SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY — never set it by hand. It is the same legacy anon
 * key the browser client uses, which is also what makes `verify_jwt: true` work
 * for these unauthenticated signup functions.
 */
export function anonClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Caller-scoped client: the anon key plus the request's own Authorization
 * header, so PostgREST runs every query as that signed-in user and RLS
 * applies.
 *
 * Read endpoints use this rather than serviceClient() on purpose. A
 * service-role read bypasses RLS entirely, which makes a forgotten
 * `.eq('user_id', ...)` filter a cross-user data leak. Going through the
 * user's own JWT means the Phase B policies are enforced by the database
 * even if the query is wrong — the filters in those endpoints are then a
 * second layer rather than the only one.
 *
 * Not for writes to Star tables: those RPCs are revoked from
 * `authenticated` and need serviceClient().
 */
export function userClient(req: Request): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}
