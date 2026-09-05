'use client';

/**
 * Which of /live/[sessionId]'s layouts this viewport gets, and — for the two
 * phone ones — which way up.
 *
 * `null` until the queries have been evaluated, which is deliberate and is the
 * whole reason this is not `useState('desktop')`. The page renders a
 * completely different tree on each side of the breakpoint, so a first client
 * render that guesses would either paint the desktop layout for one frame on a
 * phone — a 16:9 video that jumps to full-bleed — or hydrate against markup
 * the server did not produce. A caller renders the page's ground colour while
 * this is null; it resolves on the first effect, so that is at most one frame.
 *
 * WHY LANDSCAPE IS PART OF THE BREAKPOINT AND NOT JUST A MODIFIER
 *
 * A phone on its side is 812 x 375 — wider than the 767px the phone layout
 * used to be gated on, so it fell through to the desktop grid and got a 16:9
 * player in a 375px-tall window with a chat panel under it. The rule is
 * therefore "narrow, OR short and wide": under 768px either way up, and under
 * 1024px when the viewport is landscape. 1024 is where the desktop grid
 * genuinely works, and is what "desktop is unchanged" means.
 *
 * A desktop window under 1024px wide is landscape too and gets the phone
 * landscape layout. That is the correct answer for it — it has the same
 * problem a phone on its side has — and it is the same call the app's own
 * `lg:` breakpoint already makes.
 *
 * `matchMedia` rather than resize listeners, for the same reason useIsDesktop
 * in the gift overlay does it: the browser evaluates the query itself and
 * fires only when the ANSWER changes, so rotating a phone is two re-renders
 * rather than sixty.
 */

import { useEffect, useState } from 'react';

/** The last width that counts as a phone held upright. One below `md`. */
export const MOBILE_MAX_WIDTH = 767;

/** Under this, a landscape viewport is a phone on its side rather than a desktop. */
export const LANDSCAPE_MAX_WIDTH = 1023;

const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px), (max-width: ${LANDSCAPE_MAX_WIDTH}px) and (orientation: landscape)`;
const LANDSCAPE_QUERY = '(orientation: landscape)';

export type ViewerOrientation = 'portrait' | 'landscape';

/**
 * 'desktop' is the grid; the other two are the same phone component with
 * different geometry, which is what lets a rotation be a prop change rather
 * than a remount — see LiveViewerMobile.
 */
export type ViewerLayoutMode = 'desktop' | ViewerOrientation;

function useMediaQuery(query: string, fallback: boolean): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);

  useEffect(() => {
    const media =
      typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;

    // No matchMedia is a very old browser or a test environment; the fallback
    // still has to be COMMITTED rather than left as null, or the page never
    // paints.
    const read = () => setMatches(media ? media.matches : fallback);
    read();

    if (!media) return;
    media.addEventListener('change', read);
    return () => media.removeEventListener('change', read);
  }, [query, fallback]);

  return matches;
}

/** Just the orientation, for a surface that has already decided it is a phone. */
export function useViewerOrientation(): ViewerOrientation {
  // Portrait until proven otherwise: it is the taller layout, so a frame of it
  // on a landscape viewport clips rather than leaving a gap.
  return useMediaQuery(LANDSCAPE_QUERY, false) === true ? 'landscape' : 'portrait';
}

export function useViewerLayoutMode(): ViewerLayoutMode | null {
  const mobile = useMediaQuery(MOBILE_QUERY, false);
  const landscape = useMediaQuery(LANDSCAPE_QUERY, false);

  if (mobile === null || landscape === null) return null;
  if (!mobile) return 'desktop';
  return landscape ? 'landscape' : 'portrait';
}
