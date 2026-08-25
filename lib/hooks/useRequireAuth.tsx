'use client';

/**
 * Per-route auth check for protected pages. Replaces both deleted layers —
 * `middleware.ts` (server redirect via cookies) and `<RouteGuard>` (client
 * wrapper) — with one Supabase-native read the page itself performs.
 *
 * Why not a Server Component with `supabase.auth.getUser()`:
 * every client path that settles a session (signup Step2Verify, /login,
 * /reset-password) does so with `supabase.auth.setSession()` on the browser
 * client, which persists to `getAuthStorage()` — localStorage on web,
 * @capacitor/preferences on native. Auth cookies are only ever written by
 * /api/auth/login, so a server-side cookie read would bounce a just-signed-up
 * user straight back to /login. On top of that, the Capacitor build runs
 * `output: 'export'` with no server at all, so `cookies()` cannot resolve
 * there. Reading the same store the session actually lives in is what avoids
 * the localStorage-vs-cookie desync that produced the PR #15 redirect loop.
 *
 * Contract is unchanged from middleware.ts: unauthenticated users go to
 * `/login?redirect=<current-path>`, which app/login/page.tsx already reads.
 *
 * This is a UX affordance, not a security boundary. The anon key is public by
 * design; Row-Level Security is the real boundary.
 */

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useDashboardUser, type DashboardUser } from '@/lib/hooks/useDashboardUser';

export interface RequireAuthResult extends DashboardUser {
  /** True once the session check has resolved AND a user is present. */
  ready: boolean;
}

export function useRequireAuth(): RequireAuthResult {
  // useDashboardUser subscribes to onAuthStateChange, so a sign-out that
  // happens while the page is open lands here too, not just on mount.
  const session = useDashboardUser();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (session.loading || session.user) return;
    const redirect = encodeURIComponent(pathname || '/dashboard');
    router.replace(`/login?redirect=${redirect}`);
  }, [session.loading, session.user, pathname, router]);

  return { ...session, ready: !session.loading && session.user !== null };
}

/**
 * What a protected page renders while the session check is pending or the
 * redirect is in flight. A skeleton, not a blank screen — a blank screen reads
 * as a broken page — filled with the app background so nothing flashes when the
 * real content mounts. Pages must render this instead of their content: the
 * content can leak user-specific shells before the redirect completes.
 */
export function AuthPending() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className="min-h-dvh w-full animate-pulse bg-[#0a0a15]"
    />
  );
}
