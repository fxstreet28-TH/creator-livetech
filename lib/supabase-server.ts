import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase clients.
 *
 * `getServiceSupabase()` uses the service-role key and bypasses RLS — it is the
 * only client that can read/write the signup auth tables (all RLS-locked).
 * NEVER import this from a client component.
 *
 * `getAnonSupabase()` uses the public anon key and is used to sign a freshly
 * created user in (signInWithPassword) so we can mint session tokens.
 */

let serviceClient: SupabaseClient | null = null;

export function getServiceSupabase(): SupabaseClient {
  if (serviceClient) return serviceClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('Supabase service credentials are not configured');
  }

  serviceClient = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return serviceClient;
}

/**
 * A short-lived anon client. Not cached because we only use it for a single
 * server-side password sign-in per request and do not want shared auth state.
 */
export function getAnonSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase anon credentials are not configured');
  }

  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Cookie-bound Supabase client for route handlers. Uses `@supabase/ssr` with
 * the Next.js `cookies()` store, so a successful `signInWithPassword` writes the
 * session cookies onto the response automatically — the same cookie interface
 * the middleware reads to guard protected routes.
 */
export async function getRouteHandlerSupabase(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase public credentials are not configured');
  }

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options);
        });
      },
    },
  });
}
