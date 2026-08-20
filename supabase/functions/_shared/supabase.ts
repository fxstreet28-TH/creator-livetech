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
