/**
 * /dev/live-1080p — does the 1080p rung actually cost what we think it costs?
 *
 * The 1080p option raises three real numbers at once: the camera is opened at
 * 1920x1080, the published canvas becomes 1080x1920, and the screen capture is
 * allowed 1920x1080. That is 2.25x the pixels of the 720p path through every
 * stage that shares one frame budget — and PR #64 exists because that budget
 * had already been blown once, by a composite that painted late and queued.
 *
 * So this page runs the REAL pipeline at both rungs and prints the paint cost
 * against the budget. Nothing here reimplements the composite: it builds
 * synthetic sources, hands them to `createFilteredStream` exactly as
 * CreatorBroadcaster does, and reads `getStats()` — the same instrumentation
 * the ?debug=camera chip shows a creator.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT: `VERCEL_ENV` is not `NEXT_PUBLIC_`,
 * so a reference to it inside a client component is replaced with `undefined`
 * at build time — and `undefined !== 'production'` is TRUE, which would have
 * opened this page on production while looking exactly like a gate that
 * worked. Same reasoning, same shape, as the other /dev pages.
 */

import { notFound } from 'next/navigation';
import { Live1080pBench } from './Live1080pBench';

export default function DevLive1080pPage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <Live1080pBench />;
}
