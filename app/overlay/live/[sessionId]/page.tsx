/**
 * /overlay/live/[sessionId] — the OBS browser source.
 *
 * A Server Component wrapper around the client view, purely so
 * `generateStaticParams` can be exported: the Capacitor build runs
 * `output: 'export'` and Next.js refuses a dynamic segment without it. Same
 * split, and the same placeholder, as /live/[sessionId].
 *
 * NO AUTH GATE. This is the one route in the app that is deliberately not
 * behind useRequireAuth — a browser source cannot sign in. It authenticates
 * with the `?key=` in its URL, exchanged for a short-lived token by
 * `live-overlay-token`; see OverlayClient.
 */

import { OverlayClient } from './OverlayClient';

/**
 * Session ids do not exist at build time — they are created when a creator
 * presses go-live — and an EMPTY array counts as "missing" and fails the export
 * build. The exported bundle therefore gets one inert shell, exactly as
 * /live/[sessionId] does. On Vercel `dynamicParams` defaults to true, so every
 * real session renders on demand at its own URL, which is the only place this
 * route is ever used from: OBS runs against the deployed site, never against
 * the native shell.
 */
export function generateStaticParams() {
  return [{ sessionId: 'placeholder' }];
}

export default async function OverlayPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <OverlayClient sessionId={sessionId} />;
}
