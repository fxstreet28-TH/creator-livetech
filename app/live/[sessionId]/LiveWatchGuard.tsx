'use client';

/**
 * The auth gate for /live/[sessionId].
 *
 * It lives beside the route rather than in the route file because
 * app/live/[sessionId]/page.tsx has to stay a Server Component — the only
 * place `generateStaticParams` can live, which the Capacitor `output: 'export'`
 * build requires of every dynamic segment — and useRequireAuth is a hook. Same
 * split, and the same reasoning, as app/posts/[id]/PostDetailGuard.tsx.
 *
 * Login is not optional here even for a public live: `live-create-session`
 * mode=join is deployed with verify_jwt and resolves the viewer's identity to
 * mint their LiveKit token, so an anonymous visitor cannot be let into a room
 * at all. useRequireAuth reads the current pathname, so they land on
 * /login?redirect=/live/<id> and return to the live after signing in.
 */

import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { LiveWatchView } from '@/components/live/LiveWatchView';

export function LiveWatchGuard({ sessionId }: { sessionId: string }) {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return <LiveWatchView sessionId={sessionId} />;
}
