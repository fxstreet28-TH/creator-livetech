'use client';

/**
 * Where a fullscreen gift is drawn, and how big.
 *
 * TWO LAYOUTS, CHOSEN BY THE PLAYER'S WIDTH
 *
 * `centered` — the original. The stage sits in the middle of the player behind
 * a dimmed backdrop. It reads well on a phone, where there is no "beside the
 * video" to move to.
 *
 * `anchored` — desktop. The stage moves to the bottom-left corner, shrinks, and
 * loses the full-cover backdrop for a glow that reaches only as far as its own
 * edge. The reason is the creator: a gift that covers the middle of the frame
 * covers their face, and the most expensive gift on the board was doing it for
 * forty seconds at a time.
 *
 * WHICH 1024 THE BREAKPOINT IS
 *
 * The brief said "≥1024px player". Taken literally that is not the desktop
 * breakpoint it reads as: the watch page gives the player 7 of 10 columns with
 * a chat panel beside it, so a 1024px window is a 692px player and a 1280px
 * window is an 871px one. Gating on the player's own width at 1024 would have
 * left the stage sitting on the creator's face until the window reached about
 * 1500px — and the brief's own QA asks to see the new layout at 1280.
 *
 * So the gate is BOTH: the standard 1024px desktop viewport breakpoint, which
 * is what "desktop" means everywhere else in this app, AND a player physically
 * wide enough to hold the block — the left inset, the stage, a gap and a tray
 * column beside it. The second half is not a formality. It is what stops a
 * desktop window with a narrow player (a split view, a resized OBS source)
 * from getting a layout its player cannot fit.
 *
 * WHY THIS IS MEASURED IN JAVASCRIPT AND NOT COMPUTED IN CSS
 *
 * The stage is authored at 300px and scaled as a unit, so its layers keep their
 * relationship to each other at any size — and the obvious CSS for that,
 * `transform: scale(calc(var(--size) / 300px))`, is not valid: `scale()` takes
 * a number, CSS cannot divide a length by a length to produce one, and the
 * declaration is dropped silently. Every route around it is worse than
 * measuring — `zoom` composes unpredictably with the transforms the animations
 * are built from, and re-authoring forty keyframes in `em` puts a unit
 * conversion where a single wrong one is invisible until a layer drifts.
 *
 * Since the number has to exist in JS anyway, the breakpoint and the insets are
 * derived from the same measurement rather than being restated as container
 * queries that could disagree with it.
 *
 * TAKES A NODE RATHER THAN HANDING BACK A REF
 *
 * The caller holds the element in `useState` and passes the SETTER as the JSX
 * `ref`. That is not a workaround: a hook returning a callback ref would put
 * this file's ref plumbing into the caller's render, which is what
 * `react-hooks/refs` objects to. A state setter as a ref is the ordinary React
 * idiom for "re-render when this element appears", which is the requirement.
 */

import { useEffect, useState } from 'react';

/** The size every animation is authored at. */
export const STAGE_PX = 300;

/** The viewport breakpoint for "desktop" — the same 1024 the app uses elsewhere. */
export const DESKTOP_MIN_WIDTH = 1024;

/**
 * The narrowest player the anchored block fits in.
 *
 * Its parts: the 6% left inset, the 320px stage floor, the 20px gap, and the
 * 200px the tray needs before a sender's name starts rendering as "ผู้…". Below
 * this the block would push the tray off the right edge, so the centred layout
 * is the better answer even on a desktop window.
 */
export const ANCHORED_MIN_PLAYER = 580;

/** Centred mode: fraction of the player's smaller dimension. */
const CENTERED_FRACTION = 0.7;

/** Anchored mode: fraction of the player's HEIGHT, floored at ANCHORED_MIN_PX. */
const ANCHORED_FRACTION = 0.48;
const ANCHORED_MIN_PX = 320;

/**
 * Never bigger than this, however large the player is. Keeps a 1920 × 1080 OBS
 * source from blowing a 300px source image up to 750px of soft edges.
 */
const STAGE_MAX_PX = 720;

/** Never smaller than this, so a gift is never a smudge on a short player. */
const STAGE_MIN_PX = 80;

/**
 * Room left under the stage for the caption in anchored mode.
 *
 * Not a layout value — the caption is laid out by flow, not by this number.
 * It exists so a pathologically short-but-wide player (an ultrawide letterbox,
 * a mis-sized OBS source) cannot produce a stage taller than the space it has
 * to live in. At any ordinary 16:9 desktop player it never binds.
 */
const CAPTION_HEADROOM_PX = 72;

export interface OverlayBox {
  width: number;
  height: number;
}

/** Explicit anchored geometry, for a surface that knows its own canvas. */
export interface GiftAnchor {
  /** CSS length for the block's left inset. */
  left: string;
  /** CSS length for the block's bottom inset. */
  bottom: string;
  /** Stage height, in px. */
  stagePx: number;
}

export interface GiftLayout {
  anchored: boolean;
  /**
   * The stage's SIZE in px — the side of the square a CSS tier draws in, and
   * the HEIGHT of any tier including a video card, whose width then follows
   * from the clip's own aspect ratio.
   */
  stagePx: number;
  /** CSS length: the block's inset from the player's left edge. */
  left: string;
  /** CSS length: the block's inset from the player's bottom edge. */
  bottom: string;
}

const CENTERED: GiftLayout = {
  anchored: false,
  stagePx: STAGE_PX,
  left: '0px',
  bottom: '0px',
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * The layout for a player of this size.
 *
 * Pure, so the geometry can be reasoned about — and argued with — without a
 * DOM. `anchor` overrides it outright: the OBS source composites onto a canvas
 * whose size it already knows, and the numbers there were chosen against a
 * 1080p scene rather than derived from a percentage.
 */
export function giftLayout(
  box: OverlayBox,
  desktop: boolean,
  anchor?: GiftAnchor,
): GiftLayout {
  if (box.width <= 0 || box.height <= 0) return CENTERED;

  if (!desktop || box.width < ANCHORED_MIN_PLAYER) {
    const side = clamp(
      Math.min(box.width, box.height) * CENTERED_FRACTION,
      STAGE_MIN_PX,
      STAGE_MAX_PX,
    );
    return { ...CENTERED, stagePx: side };
  }

  if (anchor) {
    return { anchored: true, stagePx: anchor.stagePx, left: anchor.left, bottom: anchor.bottom };
  }

  const wanted = Math.max(box.height * ANCHORED_FRACTION, ANCHORED_MIN_PX);
  // The guard, not the design — see CAPTION_HEADROOM_PX.
  const room = box.height - box.height * 0.1 - CAPTION_HEADROOM_PX;
  return {
    anchored: true,
    stagePx: clamp(Math.min(wanted, room), STAGE_MIN_PX, STAGE_MAX_PX),
    left: '6%',
    bottom: '10%',
  };
}

/**
 * Whether this is a desktop-width window.
 *
 * `matchMedia` rather than `innerWidth` on a resize listener: the browser
 * evaluates the query itself and fires only when the answer CHANGES, so a drag
 * across a window edge is one re-render rather than sixty. Defaults to false
 * during SSR and the first client render, which is the safe direction — the
 * centred layout is the one that works at every size.
 */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const read = () => setDesktop(query.matches);
    read();
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, []);

  return desktop;
}

/**
 * The border-box size of `node`, kept current.
 *
 * Returns zeroes until the element exists, which is one frame — and every
 * animation's first keyframe is a fade-in, so nothing is visible on it.
 */
export function useElementBox(node: HTMLElement | null): OverlayBox {
  const [box, setBox] = useState<OverlayBox>({ width: 0, height: 0 });

  useEffect(() => {
    if (!node) return;

    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setBox((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
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

  return box;
}
