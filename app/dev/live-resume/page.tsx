/**
 * /dev/live-resume — background/foreground survival, on the real players.
 *
 * WHAT THIS BENCH CAN AND CANNOT ANSWER.
 *
 * It CAN answer whether the code does the thing: a WHEP session whose peer
 * connection has been closed is rebuilt when a resume event arrives; a burst of
 * resume events produces one handshake and not three; a connected session with
 * a frozen picture is rebuilt by the watchdog; three failed handshakes hand the
 * viewer on rather than looping; the tap overlay on a dead session POSTs a new
 * offer instead of calling play() into nothing; a WHIP sender takes a
 * replacement track without disturbing its peer connection. Every one of those
 * is decidable here, against the real components, with a real WebRTC session
 * looped back inside the page.
 *
 * It CANNOT answer whether an iPhone behaves the way this bench pretends it
 * does. `pc.close()` is a faithful stand-in for what iOS does to a backgrounded
 * peer connection — the spec is explicit that close() does NOT fire
 * connectionstatechange, which is exactly why the failure was invisible — but
 * headless Chromium does not suspend decoders, does not block autoplay after a
 * resume, and does not end camera tracks. The answer for Por's phone comes from
 * Por's phone; this is what stops a regression reaching it.
 *
 * `?auto=1` runs everything on load and leaves the result on
 * `window.__resumeResult` for scripts/dev-bench-resume.mjs to read over CDP.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT: `VERCEL_ENV` is not `NEXT_PUBLIC_`,
 * so a reference to it inside a client component is replaced with `undefined`
 * at build time — and `undefined !== 'production'` is TRUE, which would have
 * opened this page on production while looking exactly like a gate that
 * worked. Same reasoning, same shape, as the other /dev pages.
 */

import { notFound } from 'next/navigation';
import { ResumeBench } from './ResumeBench';

export default function DevLiveResumePage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <ResumeBench />;
}
