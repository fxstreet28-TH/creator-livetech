'use client';

/**
 * How big to draw a 300 × 300 gift stage inside the overlay it is mounted in.
 *
 * WHY THIS IS MEASURED IN JAVASCRIPT AND NOT COMPUTED IN CSS
 *
 * The obvious CSS is `transform: scale(calc(min(70vw, 70vh) / 300px))` — and it
 * is not valid: `scale()` takes a number, CSS cannot divide a length by a
 * length to produce one, and the declaration is dropped silently. Every route
 * around that is worse than measuring: `zoom` composes unpredictably with the
 * transforms the animations are built from, and re-authoring every stage in
 * `em` puts a unit conversion into forty keyframes where a single wrong one is
 * invisible until a layer drifts.
 *
 * Measuring also gives a BETTER answer than viewport units would. The overlay
 * is a sub-region of the page — the player's own box, which on a desktop layout
 * is about 70% of the width with a chat panel beside it — so a stage sized
 * against `vw` overflows it. This sizes against the box the gift is actually
 * being drawn into.
 *
 * The 720px ceiling is what keeps a 1920 × 1080 OBS browser source from
 * blowing a 300px source image up to 750px of soft edges.
 *
 * TAKES A NODE RATHER THAN HANDING BACK A REF
 *
 * The caller holds the element in `useState` and passes the SETTER as the JSX
 * `ref`. That is not a workaround: a hook that returned a callback ref would
 * have this file's ref plumbing leak into the caller's render, which is exactly
 * what `react-hooks/refs` objects to. A state setter as a ref is the ordinary
 * React idiom for "I need to re-render when this element appears", and that is
 * precisely the requirement here.
 */

import { useEffect, useState } from 'react';

/** The size every animation is authored at. */
export const STAGE_PX = 300;

/** Fraction of the overlay's smaller dimension a fullscreen gift occupies. */
const STAGE_FRACTION = 0.7;

/** Never bigger than this, however large the overlay is. */
const STAGE_MAX_PX = 720;

/** Never smaller than this, so a gift is never a smudge on a short player. */
const STAGE_MIN_PX = 80;

/**
 * The on-screen size, in px, of the stage inside `node`.
 *
 * Returns STAGE_PX until the element exists, which is one frame — the stage is
 * `opacity: 0` on that frame anyway, because every animation's first keyframe
 * is a fade-in.
 */
export function useStageSize(node: HTMLElement | null): number {
  const [size, setSize] = useState(STAGE_PX);

  useEffect(() => {
    if (!node) return;

    const measure = () => {
      const box = Math.min(node.clientWidth, node.clientHeight);
      if (box <= 0) return;
      setSize(Math.max(STAGE_MIN_PX, Math.min(STAGE_MAX_PX, box * STAGE_FRACTION)));
    };

    measure();

    // The player is resized by a phone rotating, by the browser chrome
    // collapsing on scroll, and by the OBS source being dragged — none of which
    // fire a window resize event this component would otherwise see.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return size;
}
