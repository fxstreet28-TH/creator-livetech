'use client';

/**
 * Where a fullscreen gift is drawn, and how big.
 *
 * TWO LAYOUTS, CHOSEN BY THE PLAYER'S WIDTH — OR STATED OUTRIGHT
 *
 * `centered` — the original. The stage sits in the middle of the player behind
 * a dimmed backdrop. It is still what a phone gets on the DESKTOP-shaped watch
 * layout, where the video is a 16:9 strip and there is no "beside the video"
 * to move to.
 *
 * `anchored` — desktop. The stage sits ON the player's bottom-left corner,
 * 24px up, with its caption above it, and loses the full-cover backdrop for a
 * glow that reaches only as far as its own edge. The reason is the creator: a
 * gift that covers the middle of the frame covers their face, and the most
 * expensive gift on the board was doing it for forty seconds at a time. Being
 * bottom-anchored rather than floated at 10% is the second half of that — the
 * lower the block sits, the less of the shot it is in front of.
 *
 * A caller may also hand in an explicit `anchor`, which forces the anchored
 * layout with geometry this file did not derive. Two do: the OBS source, whose
 * numbers are chosen against a 1920 × 1080 scene, and the full-bleed phone
 * watch layout, where the video fills the viewport and the free space is a
 * strip above the chat column rather than a fraction of a player. Both know
 * things about their canvas that a measurement of the overlay cannot recover.
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
 * Its parts: the 6% left inset, the stage floor (282px, and 320 when this
 * number was chosen), the 20px gap, and the 200px the tray needs before a
 * sender's name starts rendering as "ผู้…". Kept at 580 through the shrink
 * because it decides WHICH layout a player gets, and re-cutting it would move
 * windows between layouts for a reason that has nothing to do with them. Below
 * this the block would push the tray off the right edge, so the centred layout
 * is the better answer even on a desktop window.
 */
export const ANCHORED_MIN_PLAYER = 580;

/** Centred mode: fraction of the player's smaller dimension. */
const CENTERED_FRACTION = 0.7;

/**
 * Anchored mode: fraction of the player's HEIGHT, floored at ANCHORED_MIN_PX.
 *
 * Both were cut by 12% (from 0.48 and 320) when the anchored block moved down
 * onto the player's bottom edge. Sitting on the floor rather than floating at
 * 10% puts the stage nearer the tray, the chat and whatever the creator has in
 * the lower third of frame, and the smaller stage is what keeps that from
 * being a crowd.
 */
const ANCHORED_FRACTION = 0.42;
const ANCHORED_MIN_PX = 282;

/**
 * How far the anchored block's BOTTOM sits above the player's bottom edge.
 *
 * It used to be 10% of the height, which on a 1080-tall window floated the
 * stage 108px up with nothing under it. Bottom-anchored is the arrangement
 * every other overlay on these screens uses — the tray, the chips, the chat
 * input — and it is what lets the tray line up beside the stage rather than
 * being pushed out of its own corner.
 */
const ANCHORED_BOTTOM_PX = 24;

/**
 * Never bigger than this, however large the player is. Keeps a 1920 × 1080 OBS
 * source from blowing a 300px source image up to 750px of soft edges.
 */
const STAGE_MAX_PX = 720;

/** Never smaller than this, so a gift is never a smudge on a short player. */
const STAGE_MIN_PX = 80;

/**
 * Room left over the stage for the caption in anchored mode.
 *
 * Not a layout value — the caption is laid out by flow, not by this number.
 * It exists so a pathologically short-but-wide player (an ultrawide letterbox,
 * a mis-sized OBS source) cannot produce a stage taller than the space it has
 * to live in. At any ordinary 16:9 desktop player it never binds.
 */
const CAPTION_HEADROOM_PX = 72;

/** See GiftAnchor.caption. */
export type CaptionDensity = 'full' | 'compact' | 'minimal';

export interface OverlayBox {
  width: number;
  height: number;
}

/**
 * Explicit anchored geometry, for a surface that knows its own canvas.
 *
 * Passing one FORCES the anchored layout, whatever the viewport measures. Two
 * surfaces do it and neither can be derived from a percentage of a player:
 * the OBS source composites onto a 1920 x 1080 scene whose numbers were chosen
 * against that scene, and the phone layout puts the video full-bleed behind a
 * chat column and an input row that the overlay cannot see.
 */
export interface GiftAnchor {
  /** CSS length for the block's left inset. */
  left: string;
  /** CSS length for the block's bottom inset. */
  bottom: string;
  /** Stage height, in px. */
  stagePx: number;
  /**
   * Ceiling on the stage's rendered WIDTH, in px.
   *
   * Only a video card can hit it: a CSS tier is square, so its width is
   * `stagePx` and this never binds, but a 720 x 476 clip drawn at a 200px
   * height is 302px wide — half a phone's screen, and past the chat column it
   * is supposed to sit above. With this set the clip is scaled down until it
   * fits instead, so both kinds of gift occupy the same width and the layout
   * around them can be positioned against one number.
   */
  maxWidthPx?: number;
  /**
   * The block's bottom inset while the TRAY IS EMPTY.
   *
   * The stage has to clear whatever is under it, and on a phone what is under
   * it is a tray row 117px tall that is only there some of the time. Reserving
   * that height permanently means the stage floats a row's worth too high for
   * the ~90% of a broadcast with nothing in the tray; not reserving it means
   * the first Stardust lands under the caption. So the caller states both
   * positions and the overlay — which is the one thing that knows whether the
   * tray has rows — picks. Omitted means "the same either way", which is the
   * right answer for a layout whose tray moves aside instead.
   */
  bottomWithoutTray?: string;
  /** CSS length for the tray's own bottom inset. Defaults to the overlay's inset. */
  trayBottom?: string;
  /**
   * Caption above the stage rather than below it. Defaults to true, which is
   * what every anchored layout wants.
   *
   * A bottom-anchored block reads upward: the stage sits on the floor and the
   * words are the thing above it, which is also what keeps the block's bottom
   * edge equal to the STAGE's bottom edge, so the tray beside it lines up with
   * the mascot rather than with a line of text. The phone layout is the
   * exception — its stage already has the chat and the tray under it, and a
   * caption above would push into the top bar.
   */
  captionAbove?: boolean;
  /**
   * Whether the tray steps aside when a fullscreen gift is playing. Default
   * true — the desktop and OBS layouts put the stage in the tray's corner, so
   * it has to. The phone layout stacks them instead (the stage sits ABOVE the
   * tray), and a tray that also moved sideways would leave the column the chat
   * is aligned to.
   */
  trayShift?: boolean;
  /**
   * How much type the caption gets.
   *
   * 'full' is the fluid desktop scale, up to 22px of sender name across 52
   * characters. 'compact' is the phone: fixed 12/11px inside the stage's own
   * width, because the fluid scale wraps a 180px block to four lines and
   * pushes it into the tray. 'minimal' is a phone on its side, where the whole
   * viewport is 375px tall — it drops the sender's message so the block is two
   * lines, keeping the name and the star total, which are the parts that say
   * money moved.
   */
  caption?: CaptionDensity;
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
  /** See GiftAnchor.maxWidthPx. Absent means "as wide as the clip is". */
  maxWidthPx?: number;
  /** See GiftAnchor.bottomWithoutTray. Absent means "same as `bottom`". */
  bottomWithoutTray?: string;
  /** See GiftAnchor.trayBottom. Absent means "the overlay's own inset". */
  trayBottom?: string;
  /** See GiftAnchor.trayShift. */
  trayShift: boolean;
  /** See GiftAnchor.captionAbove. */
  captionAbove: boolean;
  /** See GiftAnchor.caption. */
  caption: CaptionDensity;
}

const CENTERED: GiftLayout = {
  anchored: false,
  stagePx: STAGE_PX,
  left: '0px',
  bottom: '0px',
  trayShift: true,
  // Centred mode stacks stage-then-caption in the middle of the player; there
  // is no floor for the block to sit on, so there is nothing for a caption
  // above it to be above.
  captionAbove: false,
  caption: 'full',
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
  // An explicit anchor is an instruction, not a preference, so it is read
  // BEFORE the viewport is consulted: the caller composited the numbers against
  // a canvas it already knows the size of. This is what lets the phone layout
  // — which is narrower than every "anchored" threshold below — put a gift in
  // the corner instead of over the creator's face.
  if (anchor) {
    return {
      anchored: true,
      stagePx: anchor.stagePx,
      left: anchor.left,
      bottom: anchor.bottom,
      bottomWithoutTray: anchor.bottomWithoutTray,
      maxWidthPx: anchor.maxWidthPx,
      trayBottom: anchor.trayBottom,
      trayShift: anchor.trayShift ?? true,
      captionAbove: anchor.captionAbove ?? true,
      caption: anchor.caption ?? 'full',
    };
  }

  if (box.width <= 0 || box.height <= 0) return CENTERED;

  if (!desktop || box.width < ANCHORED_MIN_PLAYER) {
    const side = clamp(
      Math.min(box.width, box.height) * CENTERED_FRACTION,
      STAGE_MIN_PX,
      STAGE_MAX_PX,
    );
    return { ...CENTERED, stagePx: side };
  }

  const wanted = Math.max(box.height * ANCHORED_FRACTION, ANCHORED_MIN_PX);
  // The guard, not the design — see CAPTION_HEADROOM_PX.
  const room = box.height - ANCHORED_BOTTOM_PX - CAPTION_HEADROOM_PX;
  return {
    anchored: true,
    stagePx: clamp(Math.min(wanted, room), STAGE_MIN_PX, STAGE_MAX_PX),
    left: '6%',
    bottom: `${ANCHORED_BOTTOM_PX}px`,
    trayShift: true,
    captionAbove: true,
    caption: 'full',
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
