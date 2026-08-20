'use client';

/**
 * Client hook that returns the currently signed-in user for dashboard pages.
 *
 * Replaces the deleted lib/session.ts `getDashboardUser()`. Uses
 * supabase.auth.getSession() which reads from the storage adapter (localStorage
 * on web, @capacitor/preferences on native) — no network, no cookies, no
 * server dependency, so this hook works identically in a static export.
 *
 * Shape:
 *   { user, displayName, email, avatarUrl, loading }
 *
 * - loading: true until the first session check resolves.
 * - user: the Supabase User object, or null if unauthenticated.
 * - displayName / email / avatarUrl: derived exactly as getDashboardUser() did,
 *   including the 'เพื่อน' fallback, so DashboardShell / TopBar / HeroWelcome
 *   need no prop-shape changes.
 */

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { getBrowserSupabase } from '@/lib/supabase-browser';

export interface DashboardUser {
  user: User | null;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  loading: boolean;
}

/**
 * Same precedence as the deleted getDashboardUser(): explicit metadata name,
 * then the email local-part, then the friendly Thai default. Never returns an
 * empty string for a signed-in user — HeroWelcome renders it as
 * "สวัสดี, {displayName}".
 */
function deriveDisplayName(user: User | null): string {
  if (!user) return '';
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const email = user.email ?? null;
  return (
    (typeof meta.display_name === 'string' && meta.display_name) ||
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    (email ? email.split('@')[0] : '') ||
    'เพื่อน'
  );
}

function deriveAvatarUrl(user: User | null): string | null {
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  return typeof meta.avatar_url === 'string' ? meta.avatar_url : null;
}

export function useDashboardUser(): DashboardUser {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    let unsubscribe = () => {};

    const settle = (next: User | null) => {
      if (cancelled) return;
      setUser(next);
      setLoading(false);
    };

    try {
      const supabase = getBrowserSupabase();

      // Initial read — cached, no network.
      supabase.auth.getSession().then(
        ({ data }) => settle(data.session?.user ?? null),
        () => settle(null),
      );

      // Live updates — sign-in, sign-out, token refresh.
      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) =>
        settle(session?.user ?? null),
      );
      unsubscribe = () => sub.subscription.unsubscribe();
    } catch {
      // getBrowserSupabase() throws synchronously when Supabase env is missing.
      // Treat that as "cannot establish a session" rather than letting it take
      // down the whole dashboard tree: the guard then sends the user to /login,
      // which is the safe direction to fail in. Deferred to a microtask so this
      // is not a synchronous setState inside the effect body.
      queueMicrotask(() => settle(null));
    }

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return {
    user,
    displayName: deriveDisplayName(user),
    email: user?.email ?? null,
    avatarUrl: deriveAvatarUrl(user),
    loading,
  };
}
