import { NextResponse } from 'next/server';

/**
 * Which build this server is serving. Nothing else.
 *
 * Read by the watch page to catch a phone running a bundle from an older
 * deploy — see lib/live/buildId.ts for why that happens and why it is worth a
 * reload. It is deliberately the smallest possible response: it is polled once
 * a minute by every viewer of every broadcast, and it must be cheaper than the
 * problem it detects.
 *
 * NO CACHING, ANYWHERE. A cached answer is worse than no answer: it would
 * report the build that was current when some CDN node last asked, which is
 * precisely the staleness this route exists to detect, and it would then send
 * viewers into a reload that changes nothing. `force-dynamic` plus an explicit
 * no-store, and the caller adds a cache-busting query on top.
 *
 * NOT AVAILABLE IN THE CAPACITOR BUILD, which is a static export with no
 * route handlers. That is handled where it matters: the client treats an
 * unreachable or unparseable answer as "no information" and never reloads on
 * it. Same shape as the four /api/auth handlers.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    { buildId: process.env.VERCEL_GIT_COMMIT_SHA || 'dev' },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
