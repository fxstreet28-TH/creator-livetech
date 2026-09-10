/**
 * /dev/live-layout — does a layout switch black out or freeze the composite?
 *
 * THE REPORT THIS PAGE EXISTS FOR. On production, sharing a Chrome window at
 * 1080p, tapping any of the four layout buttons made the whole preview go
 * black for two or three seconds and then come back FROZEN — neither the chart
 * nor the face moved again. Reproducible on every switch.
 *
 * "Frozen" is not one bug, it is a family of them, and they are told apart by
 * different measurements:
 *
 *   L1  does the PAINT LOOP survive a source that changes size underneath it?
 *       A display capture's dimensions move — a window is resized, a tab
 *       changes zoom, `applyConstraints` reconfigures the capturer — and a
 *       source rectangle computed from the old ones describes pixels the
 *       decoder no longer has. Measured by shrinking a synthetic 2560x1440
 *       source to 1920x1080 mid-composite and watching the frame counter.
 *   L2  does the loop survive an EXCEPTION in the paint callback? Measured by
 *       making `drawImage` throw, on purpose, for a second — under both
 *       painters, because they fail differently: the worker ticker survives an
 *       uncaught throw and the frame-callback chain does not, and the chain is
 *       the painter wherever a Worker cannot be built.
 *   L3  how many times does a share RECONFIGURE its capture track? This is the
 *       black. `applyConstraints` on a live display capture stops frames for a
 *       second or more, and PR #68 called it from an effect keyed on the
 *       layout. Measured with a stubbed `getDisplayMedia` whose track counts
 *       the calls, across twenty layout switches.
 *   L4  how large is the chart in each layout, before and after? Pure
 *       arithmetic over `layoutRects`, `screenSlotFit`, `containRect` and
 *       `coverSourceRect` — the same functions the paint loop calls.
 *   L5  is the creator's preview the shape of what they are publishing? A real
 *       div, with the studio's own class string, measured by the browser.
 *
 * WHAT IS SYNTHETIC AND WHAT IS REAL. The two sources are canvases captured as
 * tracks, and the display picker is stubbed — neither a monitor nor a chooser
 * exists in CI. Everything else is the shipping code: `createFilteredStream`,
 * `setSecondSource`, `setCompositeLayout`, `startScreenShare` itself, and the
 * studio's own preview classes.
 *
 * WHAT IT CANNOT SETTLE. There is no GPU here, so every millisecond is an
 * upper bound and `hardwareConcurrency` is the container's, not a creator's —
 * which means the capture DECISION this bench observes may differ from the one
 * a MacBook makes. The property under test is not which way it decided; it is
 * that it decided AT MOST ONCE and never again.
 *
 * `?auto=1` runs everything on load and leaves the result on
 * `window.__layoutResult` for scripts/dev-bench-layout.mjs to read over CDP.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT: `VERCEL_ENV` is not `NEXT_PUBLIC_`,
 * so a reference to it inside a client component is replaced with `undefined`
 * at build time — and `undefined !== 'production'` is TRUE, which would have
 * opened this page on production while looking exactly like a gate that
 * worked. Same reasoning, same shape, as the other /dev pages.
 */

import { notFound } from 'next/navigation';
import { LayoutSwitchBench } from './LayoutSwitchBench';

export default function DevLiveLayoutPage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <LayoutSwitchBench />;
}
