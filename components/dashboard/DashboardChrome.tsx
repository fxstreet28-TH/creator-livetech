'use client';

/**
 * Client bridge between the dashboard layout and DashboardShell.
 *
 * DashboardShell needs displayName / email / avatarUrl, which used to come
 * from `await getDashboardUser()` in a server layout. Those now come from
 * useDashboardUser(), which is a hook and so needs a client component.
 *
 * This exists as its own component because app/dashboard/layout.tsx must
 * stay a Server Component: it exports `metadata`, and Next.js rejects a
 * `metadata` export from a module marked 'use client'. The layout keeps the
 * metadata, and this holds the client-side user read.
 *
 * Rendered inside <RouteGuard>, so by the time it mounts the session is
 * already resolved and non-null.
 */

import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';

interface DashboardChromeProps {
  children: React.ReactNode;
}

export function DashboardChrome({ children }: DashboardChromeProps) {
  const { displayName, email, avatarUrl } = useDashboardUser();

  return (
    <DashboardShell displayName={displayName} email={email} avatarUrl={avatarUrl}>
      {children}
    </DashboardShell>
  );
}
