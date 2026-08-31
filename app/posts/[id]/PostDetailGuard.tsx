'use client';

/**
 * The auth gate for /posts/[id].
 *
 * It lives beside the route rather than in the route file because
 * app/posts/[id]/page.tsx has to stay a Server Component — it is the only
 * place `generateStaticParams` can live, which the Capacitor `output:
 * 'export'` build requires of every dynamic segment — and useRequireAuth is a
 * hook. Nothing but the gate belongs here: the page body is still
 * PublicPostView, which knows nothing about auth.
 *
 * useRequireAuth reads the current pathname, so an anonymous visitor lands on
 * /login?redirect=/posts/<id> and returns to this post after signing in.
 */

import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { PublicPostView } from '@/components/viewer/PublicPostView';

export function PostDetailGuard({ postId }: { postId: string }) {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return <PublicPostView postId={postId} />;
}
