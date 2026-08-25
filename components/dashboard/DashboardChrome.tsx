'use client';

/**
 * Client bridge between the dashboard layout and DashboardShell, and the auth
 * check for every route under /dashboard.
 *
 * The check lives here rather than in app/dashboard/page.tsx for two reasons:
 * it covers future /dashboard/* subroutes the way the deleted middleware
 * matcher did, and it stops the chrome (sidebar, top bar) from painting for a
 * user who is about to be redirected.
 *
 * This exists as its own component because app/dashboard/layout.tsx must stay
 * a Server Component: it exports `metadata`, and Next.js rejects a `metadata`
 * export from a module marked 'use client'.
 */

import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';

interface DashboardChromeProps {
  children: React.ReactNode;
}

export function DashboardChrome({ children }: DashboardChromeProps) {
  // One useDashboardUser instance backs both the guard and the shell props.
  const { ready, displayName, email, avatarUrl } = useRequireAuth();

  if (!ready) return <AuthPending />;

  return (
    <DashboardShell displayName={displayName} email={email} avatarUrl={avatarUrl}>
      {children}
    </DashboardShell>
  );
}
