/**
 * /creator/posts/[id] — view, edit or delete one post.
 *
 * A Server Component wrapper around a client view, purely so
 * `generateStaticParams` can be exported: the Capacitor build runs
 * `output: 'export'`, and Next.js refuses to build a dynamic segment without
 * it. Nothing here reads cookies or any other server-only API, so the export
 * still resolves.
 */

import { PostDetailView } from '@/components/creator/PostDetailView';

/**
 * The Capacitor build runs `output: 'export'`, and Next.js refuses to export a
 * dynamic segment that has no generateStaticParams — an EMPTY array counts as
 * "missing" and fails the build, so returning one is not an option. Post ids
 * are per-creator and unknowable at build time, so the exported bundle gets a
 * single inert shell at /creator/posts/placeholder/ and nothing else.
 *
 * On Vercel this is harmless: `dynamicParams` defaults to true, so every real
 * post id is rendered on demand at its own URL, which is the only environment
 * these screens are reachable from today — the native shell has no entry point
 * into /creator/**, because nothing in the app nav links there.
 * TODO(day-9): if creator tools ship in the native app, give it a query-param
 * route (/creator/posts/detail?id=) rendering this same view, since a static
 * export cannot serve per-id HTML.
 */
export function generateStaticParams() {
  return [{ id: 'placeholder' }];
}

export default async function CreatorPostDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PostDetailView postId={id} />;
}
