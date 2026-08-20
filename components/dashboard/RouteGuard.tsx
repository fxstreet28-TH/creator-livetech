'use client';

/**
 * Client-side auth guard for protected routes.
 *
 * Replaces middleware.ts behaviour inside the Capacitor shell (where
 * middleware does not run). On the web, middleware still runs — this
 * guard is additive defence-in-depth until PR 6 removes middleware.
 *
 * Contract: identical to middleware.ts — unauthenticated users are
 * redirected to /login?redirect=<current-path>. app/login/page.tsx already
 * reads the `redirect` query param, so no login-side change is needed.
 *
 * This is a UX affordance, not a security boundary. Anyone can edit their
 * own JavaScript or call Supabase directly with the anon key, which is
 * public by design. Row-Level Security is the real boundary.
 *
 * Loading state: a lightweight skeleton, NOT a blank screen. A blank
 * screen during the brief pending window reads as a broken page.
 */

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';

interface RouteGuardProps {
  children: React.ReactNode;
}

export function RouteGuard({ children }: RouteGuardProps) {
  const { user, loading } = useDashboardUser();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      const redirect = encodeURIComponent(pathname || '/dashboard');
      router.replace(`/login?redirect=${redirect}`);
    }
  }, [loading, user, pathname, router]);

  // Pending: show skeleton, do NOT render children (children may leak
  // user-specific UI shells that flash before the redirect).
  // The fill matches the dashboard's own background so there is no colour
  // flash when the real chrome mounts.
  if (loading || !user) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading"
        className="min-h-dvh w-full animate-pulse bg-[#0a0a15]"
      />
    );
  }

  return <>{children}</>;
}
