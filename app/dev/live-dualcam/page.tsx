/**
 * /dev/live-dualcam — the mobile dual-camera composite, on the real pipeline.
 *
 * TWO QUESTIONS, AND ONLY ONE OF THEM CAN BE ANSWERED HERE.
 *
 * The first is geometry and cost: given two camera sources, does the composite
 * put the BACK one in the top slot and the FRONT one below, both `cover`, at
 * 720x1280 and 24fps, with no black bars inside either slot? That is decidable
 * without a phone — synthetic sources, the real `createFilteredStream`, and
 * pixels read back out of the published track — and it is what this page
 * checks, including the negative control that proves the `contain` path still
 * behaves like a screen share.
 *
 * The second is whether a given phone will run both cameras at once, and NO
 * BENCH CAN ANSWER IT. It is a property of the device and of the browser on
 * it: headless Chromium with `--use-fake-device-for-media-stream=device-count=2`
 * happily opens two fake cameras and reports Tier 1, which proves the probe's
 * happy path runs and proves nothing whatsoever about an iPhone. The probe row
 * below reports what THIS browser did, and the answer for Por's phone comes
 * from Por's phone.
 *
 * `?auto=1` runs everything on load and leaves the result on
 * `window.__dualcamResult` for scripts/dev-bench-dualcam.mjs to read over CDP.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT: `VERCEL_ENV` is not `NEXT_PUBLIC_`,
 * so a reference to it inside a client component is replaced with `undefined`
 * at build time — and `undefined !== 'production'` is TRUE, which would have
 * opened this page on production while looking exactly like a gate that
 * worked. Same reasoning, same shape, as the other /dev pages.
 */

import { notFound } from 'next/navigation';
import { DualCameraBench } from './DualCameraBench';

export default function DevLiveDualCamPage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <DualCameraBench />;
}
