/**
 * /posts/[id] — the public post detail.
 *
 * A Server Component wrapper around a client view, purely so
 * `generateStaticParams` can be exported: the Capacitor build runs
 * `output: 'export'`, and Next.js refuses to build a dynamic segment without
 * it. Nothing here reads cookies or any other server-only API, so the export
 * still resolves.
 */

import { PublicPostView } from '@/components/viewer/PublicPostView';

/**
 * An EMPTY array counts as "missing" and fails the export build, so returning
 * one is not an option, and post ids are unknowable at build time. The
 * exported bundle therefore gets a single inert shell at /posts/placeholder/.
 *
 * On Vercel this is harmless: `dynamicParams` defaults to true, so every real
 * post id is rendered on demand at its own URL. Same trade-off, and the same
 * TODO, as app/creator/posts/[id]/page.tsx.
 * TODO(day-9): if the native shell needs post detail, give it a query-param
 * route (/posts/detail?id=) rendering this same view, since a static export
 * cannot serve per-id HTML.
 */
export function generateStaticParams() {
  return [{ id: 'placeholder' }];
}

export default async function PublicPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PublicPostView postId={id} />;
}
