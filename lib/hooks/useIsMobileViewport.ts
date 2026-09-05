'use client';

/**
 * Whether the viewport is narrow enough for the phone layout of a page that
 * has two of them.
 *
 * `null` until the query has been evaluated, which is deliberate and is the
 * whole reason this is not `useState(false)`. /live/[sessionId] renders a
 * completely different tree on each side of the breakpoint, so a first client
 * render that guesses would either paint the desktop layout for one frame on a
 * phone — a 16:9 video that jumps to full-bleed — or hydrate against markup
 * the server did not produce. A caller renders nothing (or a black ground)
 * while this is null; it resolves on the first effect, so that is at most one
 * frame.
 *
 * `matchMedia` rather than a resize listener, for the same reason
 * useIsDesktop in the gift overlay does it: the browser evaluates the query
 * itself and fires only when the ANSWER changes, so rotating a phone or
 * dragging a window edge is one re-render rather than sixty.
 *
 * 767px, not 768: `max-width` is inclusive, so this is the exact complement of
 * the `md:` (min-width: 768px) breakpoint the rest of the app is built on.
 */

import { useEffect, useState } from 'react';

/** The last width that counts as a phone. One below the app's `md` breakpoint. */
export const MOBILE_MAX_WIDTH = 767;

export function useIsMobileViewport(): boolean | null {
  const [mobile, setMobile] = useState<boolean | null>(null);

  useEffect(() => {
    // No matchMedia is either a very old browser or a test environment; the
    // desktop layout is the safe answer for both, and it still has to be
    // COMMITTED rather than left as null, or the page never paints.
    const query =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`)
        : null;

    const read = () => setMobile(query ? query.matches : false);
    read();

    if (!query) return;
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, []);

  return mobile;
}
