'use client';

/**
 * The two viewport measurements the full-bleed watch layout needs and CSS
 * cannot give it.
 */

import { useEffect, useState } from 'react';

/**
 * How much of the viewport the on-screen keyboard is covering, in px.
 *
 * THE PROBLEM THIS SOLVES. On iOS Safari the keyboard does not resize the
 * layout viewport — `100dvh`, `position: fixed` and `bottom: 0` all keep
 * pointing at the bottom of the SCREEN, which is now behind the keyboard. The
 * chat input row, which is the one control that must stay visible while
 * someone types into it, ends up underneath it. Android Chrome resizes instead
 * and needs none of this, which is why the answer is a measurement rather than
 * a platform check: on Android it measures 0 and the layout is unchanged.
 *
 * `visualViewport` is the only API that reports the keyboard at all. The
 * quantity is the layout viewport's height minus the part of it still visible:
 * `offsetTop` covers the case where the page has been scrolled up to keep the
 * focused field in view, which iOS does on its own.
 *
 * Both `resize` and `scroll` are listened to, because iOS reports the keyboard
 * opening as a resize and the shift that follows it as a scroll — handling
 * only one leaves the row half a keyboard out of place for as long as the
 * field has focus.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = typeof window === 'undefined' ? null : window.visualViewport;
    if (!viewport) return;

    const read = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      // Rounded, and floored at zero: sub-pixel noise from the browser's own
      // scaling would otherwise re-render the page on every scroll frame, and
      // a negative value (which Safari briefly reports mid-animation) would
      // push the row off the bottom of the screen.
      const next = Math.max(0, Math.round(covered));
      setInset((current) => (current === next ? current : next));
    };

    read();
    viewport.addEventListener('resize', read);
    viewport.addEventListener('scroll', read);
    return () => {
      viewport.removeEventListener('resize', read);
      viewport.removeEventListener('scroll', read);
    };
  }, []);

  return inset;
}

/**
 * The viewport's width in px, kept current.
 *
 * Needed because the gift stage's size is a NUMBER handed to GiftOverlay, not
 * a CSS length: the animations are authored at 300px and scaled as a unit, so
 * the factor has to exist in JavaScript (see useStageScale.ts). `min(52vw,
 * 200px)` therefore has to be computed rather than written.
 *
 * Zero until the first effect, which is the safe direction — the caller floors
 * the result, so one frame of the minimum stage is the worst case and no gift
 * is on screen on a first paint anyway.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const read = () => setWidth(window.innerWidth);
    read();
    window.addEventListener('resize', read);
    window.addEventListener('orientationchange', read);
    return () => {
      window.removeEventListener('resize', read);
      window.removeEventListener('orientationchange', read);
    };
  }, []);

  return width;
}
