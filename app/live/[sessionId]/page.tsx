/**
 * /live/[sessionId] — the live watch page.
 *
 * A Server Component wrapper around a client view, purely so
 * `generateStaticParams` can be exported: the Capacitor build runs
 * `output: 'export'`, and Next.js refuses to build a dynamic segment without
 * it. Nothing here reads cookies or any other server-only API, so the export
 * still resolves.
 *
 * Login required, like every viewer route: the gate is LiveWatchGuard, which
 * has to be a separate client module because this file cannot be one.
 */

import { LiveWatchGuard } from './LiveWatchGuard';

/**
 * An EMPTY array counts as "missing" and fails the export build, so returning
 * one is not an option, and live session ids are unknowable at build time —
 * they do not exist until a creator presses go-live. The exported bundle
 * therefore gets a single inert shell at /live/placeholder/.
 *
 * On Vercel this is harmless: `dynamicParams` defaults to true, so every real
 * session id is rendered on demand at its own URL. Same trade-off, and the
 * same TODO, as app/posts/[id]/page.tsx.
 * TODO(post-launch): if the native shell needs the watch page, give it a
 * query-param route (/live/watch?id=) rendering this same view, since a static
 * export cannot serve per-id HTML.
 */
export function generateStaticParams() {
  return [{ sessionId: 'placeholder' }];
}

export default async function LiveSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <LiveWatchGuard sessionId={sessionId} />;
}
