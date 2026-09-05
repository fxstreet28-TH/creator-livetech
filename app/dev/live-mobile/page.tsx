/**
 * /dev/live-mobile — the phone watch layout, without a broadcast.
 *
 * Same argument as /dev/gifts, applied to a layout instead of an animation:
 * seeing this screen through the real path means a creator on air, a second
 * device, a funded wallet and a star spent per gift. That is the right test
 * for the money and a hopeless loop for checking that the chat column clears
 * the gift tray on a 375px screen. So this page hands LiveViewerMobile a
 * FABRICATED page state — chat lines, a gift, a viewer count — and renders the
 * real component tree around it. Nothing here spends a star, writes a row, or
 * joins a channel.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT
 *
 * It has to be. `VERCEL_ENV` is not `NEXT_PUBLIC_`, so a reference to it inside
 * a client component is replaced with `undefined` at build time — and
 * `undefined !== 'production'` is TRUE, which would have opened this page on
 * production while looking exactly like a gate that worked. Read here, on the
 * server, it is the real value; the check runs at build time, so the route is
 * simply not in the production bundle rather than being served and then hidden.
 */

import { notFound } from 'next/navigation';
import { LiveMobileBench } from './LiveMobileBench';

export default function DevLiveMobilePage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <LiveMobileBench />;
}
