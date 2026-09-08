'use client';

/**
 * Which kind of device the CREATOR is broadcasting from.
 *
 * Note what this is not. The viewer decides how to fit a picture from the
 * SOURCE's own shape — a landscape track gets letterboxed into a phone,
 * a portrait one fills it — and that is right there, because the viewer is
 * looking at a frame and has no idea who sent it.
 *
 * This is the other half, and it asks a different question: who is SENDING?
 * A creator at a laptop and a creator holding a phone need different framing
 * out of the publisher, and neither `videoWidth > videoHeight` nor the user
 * agent answers that. A tablet held sideways is still a phone-shaped
 * broadcast; a webcam that hands back 3:4 is still a desktop one.
 *
 * So the answer is the VIEWPORT, at the same 768px the rest of the app splits
 * its layouts on — the width that already decides whether /creator/live
 * renders the phone studio or the desktop one. Nothing new gets to be a
 * "device" here.
 */

import { MOBILE_MAX_WIDTH } from '@/lib/hooks/useIsMobileViewport';

/**
 * True when the creator is at a desktop-width viewport.
 *
 * READ ONCE, AT CAPTURE SETUP, AND NEVER AGAIN — which is why this is a plain
 * function and pointedly not a hook. The publisher's framing is baked into a
 * canvas whose dimensions the encoder has already negotiated, so a creator who
 * drags their window narrow halfway through a broadcast keeps the mode they
 * started in. Re-deciding mid-stream would mean resizing a published track,
 * which is the renegotiation stall this pipeline avoids everywhere else.
 *
 * False without `matchMedia` — SSR, and browsers old enough not to have it.
 * That is the pass-through answer, so the unknown case changes nothing.
 */
export function isDesktopBroadcastViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  // MOBILE_MAX_WIDTH + 1, not a literal 768: `max-width: 767px` and
  // `min-width: 768px` have to stay exact complements, and writing the number
  // twice is how they stop being.
  return window.matchMedia(`(min-width: ${MOBILE_MAX_WIDTH + 1}px)`).matches;
}
