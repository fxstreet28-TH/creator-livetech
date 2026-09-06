/**
 * /dev/camera-looks — the two look implementations, on the same frame.
 *
 * Every preset in this app now exists twice: once as a `ctx.filter` string and
 * once as a stack of composite blend passes, for the WebKit versions where
 * `ctx.filter` is absent and assigning to it does nothing at all. The second
 * one is an approximation of the first, and an approximation nobody has put
 * beside the original is just a guess.
 *
 * The problem with checking it on the device that needs it: that device is
 * exactly the one that CANNOT draw the reference. So this page forces both
 * paths on a browser where both work, from a single synthetic frame, and
 * measures the gap in numbers as well as showing it.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT: `VERCEL_ENV` is not `NEXT_PUBLIC_`,
 * so a reference to it inside a client component is replaced with `undefined`
 * at build time — and `undefined !== 'production'` is TRUE, which would have
 * opened this page on production while looking exactly like a gate that
 * worked. Same reasoning, same shape, as the other /dev pages.
 */

import { notFound } from 'next/navigation';
import { CameraLooksBench } from './CameraLooksBench';

export default function DevCameraLooksPage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <CameraLooksBench />;
}
