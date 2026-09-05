/**
 * /dev/gifts — the gift overlay bench.
 *
 * Testing an overlay through the real path means two browsers, a creator on
 * air, a funded wallet and a star spent per attempt. That is the right test for
 * the money and the wrong loop for tuning a keyframe, so this page enqueues
 * fabricated events straight into the same GiftOverlay every live screen
 * mounts. Nothing here spends a star, writes a row, or reaches the network.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT
 *
 * It has to be. `VERCEL_ENV` is not `NEXT_PUBLIC_`, so a reference to it inside
 * a client component is replaced with `undefined` at build time — and
 * `undefined !== 'production'` is TRUE, which would have opened this page on
 * production while looking exactly like a gate that worked. Read here, on the
 * server, it is the real value; the check runs at build time, so the route is
 * simply not in the production bundle rather than being served and then hidden.
 *
 * Preview deployments and local development both render it, which is the point:
 * the CEO needs to see all seven tiers on a Vercel preview without a broadcast.
 */

import { notFound } from 'next/navigation';
import { GiftBench } from './GiftBench';

export default function DevGiftsPage() {
  // `VERCEL_ENV` is 'production' | 'preview' | 'development' on Vercel, and
  // absent locally and in the Capacitor export — absent means "not production",
  // which is the correct reading for both.
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <GiftBench />;
}
