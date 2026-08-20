'use client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getAuthStorage } from './storage/authStorage';

/**
 * The single browser-side Supabase client. Every client component must go
 * through `getBrowserSupabase()` — signup (`auth.setSession`), logout
 * (`auth.signOut`), and any future client-side query — so that one store holds
 * the session. Constructing a second client elsewhere reintroduces the
 * split-brain bug this module exists to prevent.
 *
 * Session persistence goes through `getAuthStorage()` rather than the default
 * localStorage so a later PR can swap in @capacitor/preferences for the native
 * shell without touching a single consumer.
 */
let browserClient: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase public credentials are not configured');
  }

  browserClient = createClient(url, anonKey, {
    auth: {
      storage: getAuthStorage(),
      storageKey: 'creatorlive.auth.token', // explicit, stable key — do not omit
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // no OAuth redirect flow yet
    },
  });
  return browserClient;
}
