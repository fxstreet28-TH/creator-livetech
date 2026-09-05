'use client';

/**
 * Fire `onDone` once, `durationMs` after the animation mounts.
 *
 * A timer rather than `onAnimationEnd`, and the reason is not style. A stage
 * has several layers animating at once, so `animationend` bubbles up several
 * times and there is no reliable "the last one" to latch onto; a layer whose
 * animation is suppressed (`prefers-reduced-motion`, a hidden tab, a browser
 * that skipped it) never fires at all, and the callback would be lost for the
 * one viewer who most needs the money confirmation to complete.
 *
 * The timer is the animation's own contract with the queue: both are driven by
 * `gift_tiers.duration_ms`, so they cannot disagree about how long a gift
 * lasts.
 */

import { useEffect, useRef, useState } from 'react';

export function useAnimationDone(durationMs: number, onDone?: () => void): boolean {
  const [done, setDone] = useState(false);

  /**
   * Held in a ref so a caller passing an inline arrow — which every caller
   * does — cannot restart the timer on each render. The animation would then
   * never finish on a screen that re-renders faster than the gift lasts, which
   * is exactly what a live chat panel beside it guarantees.
   */
  const callback = useRef(onDone);
  useEffect(() => {
    callback.current = onDone;
  }, [onDone]);

  /**
   * No reset on re-run.
   *
   * `done` starts false on mount, and both callers mount a FRESH component per
   * gift — GiftFullscreen keys on the queue's item key, GiftTray on the combo
   * bump — because the animations run once with `forwards` and a reused element
   * would hold the previous gift's last frame. So `durationMs` changing under a
   * mounted stage does not happen, and resetting here would only add a
   * cascading render on every mount.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      setDone(true);
      callback.current?.();
    }, Math.max(0, durationMs));
    return () => clearTimeout(timer);
  }, [durationMs]);

  return done;
}
