'use client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client. Used only to set the session returned by
 * /api/auth/complete-signup via `supabase.auth.setSession(...)` so the user is
 * signed in on the client after a successful signup.
 */
let browserClient: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase public credentials are not configured');
  }

  browserClient = createClient(url, anonKey);
  return browserClient;
}
