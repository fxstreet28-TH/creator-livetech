'use client';

/**
 * The auth gate for /c/[handle].
 *
 * Same split, and for the same reason, as app/posts/[id]/PostDetailGuard.tsx:
 * the route file has to stay a Server Component so `generateStaticParams` can
 * be exported, and useRequireAuth is a hook. The profile body remains
 * CreatorProfilePlaceholder, untouched.
 *
 * useRequireAuth reads the current pathname, so an anonymous visitor lands on
 * /login?redirect=/c/<handle> and returns to this profile after signing in.
 */

import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { CreatorProfilePlaceholder } from '@/components/viewer/CreatorProfilePlaceholder';

export function CreatorProfileGuard({ handle }: { handle: string }) {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return <CreatorProfilePlaceholder handle={handle} />;
}
