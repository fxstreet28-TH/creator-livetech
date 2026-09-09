/**
 * THE TIKTOK-LIVE LAYOUT: a screen and a face, arranged, one frame out.
 *
 * This module is the LAYOUT, and nothing else. No canvas, no video element, no
 * draw loop — just the slot rectangles and the two fitting rules that place a
 * source inside one of them. The drawing lives in createFilteredStream (see
 * ./cameraFilters), because there is already exactly one loop there reading
 * exactly one decoded frame per camera frame, and a second loop painting a
 * second canvas would double the per-frame cost of a broadcast to produce a
 * picture that could then be a frame out of step with the first.
 *
 * Keeping the arithmetic here, as pure functions over numbers, is what makes
 * it checkable: `containRect` and `coverSourceRect` can be reasoned about and
 * exercised without a browser, and a wrong slot shows up as a wrong number
 * rather than as a creator squinting at a preview.
 *
 * THE OUTPUT IS 9:16, AND ITS SHAPE IS FIXED WHILE ITS SIZE IS NOT.
 * Everywhere else in this pipeline the canvas follows the camera — a desktop
 * webcam publishes 1280x720 landscape, a phone publishes whatever upright
 * frame its sensor gave — because the camera's own ratio is the honest one to
 * publish. A composite has no such ratio to inherit: it is a frame we are
 * composing, its shape is a design decision, and the decision is the one the
 * audience is holding. 9:16 fills a phone edge to edge with no bars anywhere,
 * which is the entire point of the layout.
 *
 * The SIZE follows the creator's quality rung — 720x1280, or 1080x1920 when
 * they picked 1080p. That is the whole of what makes 1080p real rather than a
 * label: a 720x1280 canvas published under a 9 Mbps ceiling is 720p of detail
 * at 1080p prices, and a chart's thin lines and small axis labels are exactly
 * the content where the difference is visible on a phone. Every rectangle in
 * this file is therefore derived from a size PASSED IN rather than from a
 * module constant, and the constants that remain are the 720p rung's values,
 * which is what every caller that does not care gets.
 *
 * WHY THE CREATOR CHOOSES. This started as one fixed 55/45 split, on the
 * reasoning that a landscape share needs width and a face reads fine in a
 * shorter box. That reasoning is fine and it is still what `split` does — it
 * was just never ours to settle. A creator walking through a chart wants the
 * chart big and themselves small; a creator reacting to what is on screen
 * wants the opposite; a creator reading a document wants to be out of the way
 * entirely. Those are three different broadcasts, and the person making them
 * is the one who knows which is which.
 *
 * So there are three presets and a corner, and `layoutRects` is the whole of
 * it: give it a layout, a corner and a canvas size, get back where the two
 * pictures go. Every rectangle in this file is derived from that size, so
 * nothing can drift out of the frame at either rung, and every one is even —
 * these are destination rectangles on a canvas whose frames reach an H.264
 * encoder, and odd dimensions are a thing some encoders refuse.
 */

import type { BroadcastQuality } from './types';

/**
 * How a source is placed inside its slot.
 *
 * TWO RULES, AND WHICH ONE APPLIES IS A PROPERTY OF THE SOURCE, not of the
 * slot. A shared screen is `contain`: it is information laid out to its own
 * edges, and cropping a trading chart to fill a slot cuts the price axis off
 * one side and the time axis off the other. A camera is `cover`: it is a
 * subject in the middle of a frame, and black bars around a person are the
 * thing this whole layout exists to avoid.
 *
 * The top slot takes either, because since the mobile dual-camera path it
 * holds either — a shared screen on a desktop, a BACK CAMERA on a phone. See
 * `setSecondSource` in ./cameraFilters, which is where the choice is made.
 */
export type SlotFit = 'contain' | 'cover';

/** A box on the composite canvas, in canvas pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A published composite frame's dimensions, in canvas pixels. 9:16, always. */
export interface CompositeSize {
  width: number;
  height: number;
}

/** The published composite frame at the 720p rung. The default everywhere. */
export const COMPOSITE_WIDTH = 720;
export const COMPOSITE_HEIGHT = 1280;

export const COMPOSITE_SIZE_720: CompositeSize = {
  width: COMPOSITE_WIDTH,
  height: COMPOSITE_HEIGHT,
};

/**
 * The published composite frame at the 1080p rung.
 *
 * 1080x1920 — the same 9:16, exactly 1.5x on each axis, 2.25x the pixels. It is
 * a MULTIPLE of the 720 frame on purpose: every slot in every layout is a
 * proportion of the frame, so a chart in ครึ่ง-ครึ่ง lands at 1080x1056 instead
 * of 720x704 and the arrangement a creator learned at 720p is pixel-for-pixel
 * the same arrangement, just larger.
 */
export const COMPOSITE_SIZE_1080: CompositeSize = { width: 1080, height: 1920 };

/**
 * The frame a quality rung publishes.
 *
 * ONLY 1080p gets the larger frame, and the lower rungs are deliberately left
 * where they are rather than given a proportional 480x854 or 360x640. The
 * composite frame is not what makes a low rung cheap — the bitrate ceiling is,
 * and `publishBitrateFor` already does that. Shrinking the canvas as well would
 * take a creator who chose 360p to save their phone's data plan and also make
 * their chart unreadable, which is not the trade they asked for.
 *
 * The consequence, stated plainly: 360p and 480p publish a 720x1280 canvas
 * under a lower ceiling, exactly as they have since PR #62. Nothing about them
 * changes here.
 */
export function compositeSizeFor(quality: BroadcastQuality): CompositeSize {
  return quality === '1080p' ? COMPOSITE_SIZE_1080 : COMPOSITE_SIZE_720;
}

/**
 * The whole frame, at a given size. `pip` and `screen` give the share all of it.
 *
 * A function rather than a constant now that the size is a choice — FULL_FRAME
 * below is this at the 720p rung, kept because most of this pipeline still has
 * one frame size and reads better saying so.
 */
export function fullFrame(size: CompositeSize = COMPOSITE_SIZE_720): Rect {
  return { x: 0, y: 0, width: size.width, height: size.height };
}

/**
 * HOW OFTEN A COMPOSITE FRAME IS PAINTED, AND WHY IT IS NOT 30.
 *
 * A camera-only broadcast is one decode, one paint of one source, one encode,
 * and it fits in a 33ms budget with room to spare. A composite is two decodes
 * (camera and screen), a paint that draws both, and an encode of a frame where
 * EVERY pixel has detail — a chart is thin lines and small text corner to
 * corner, which is close to the worst case an H.264 encoder can be handed at
 * 30fps on a laptop. Those four costs share one 33ms budget, and when they do
 * not fit the encoder stops finishing frames on time: they queue, the queue is
 * latency, and the viewer sees the chart arrive seconds late and then jump.
 *
 * 24 buys each stage a 41.7ms budget instead — 24% more time, given away by
 * the one thing in the frame that does not need 30: a chart. Cinema has run at
 * 24 for a century; a candlestick scrolling at 24 is indistinguishable from one
 * scrolling at 30 to anyone who is not counting, and it is emphatically better
 * than one scrolling at 30 three seconds late.
 *
 * The camera-only path keeps its 30 (see createFilteredStream's `frameRate`).
 * This is the composite's rate, applied while a share is running and given up
 * the moment it stops.
 */
export const COMPOSITE_FRAME_RATE = 24;

/**
 * The largest screen capture worth asking a browser for.
 *
 * The screen's slot in every layout is at most COMPOSITE_WIDTH across, so a
 * 2560x1440 or 3840x2160 capture is pixels fetched, decoded and then thrown
 * away by `drawImage` on the main thread, every single frame. Constraining
 * `getDisplayMedia` moves that downscale into the browser's own capture path,
 * where it is done off the main thread and once — see lib/live/screenShareCapture.
 *
 * 1280x720 rather than 720x1280-shaped: shared surfaces are landscape (a
 * monitor, a window, a tab) and the constraint is a MAXIMUM on each axis, so a
 * portrait or square surface is capped just as well by the larger of the two.
 * Larger than the slot on purpose — a 720-wide capture drawn into a 720-wide
 * slot would leave nothing for a creator who picks เฉพาะหน้าจอ, where the
 * screen is drawn full width and a little oversampling keeps text crisp.
 */
export const SCREEN_CAPTURE_MAX_WIDTH = 1280;
export const SCREEN_CAPTURE_MAX_HEIGHT = 720;

/** The same cap at the 1080p rung: 1.5x each axis, as the frame itself is. */
export const SCREEN_CAPTURE_MAX_WIDTH_1080 = 1920;
export const SCREEN_CAPTURE_MAX_HEIGHT_1080 = 1080;

/**
 * The capture cap for a quality rung — and the reason 1080p is not free.
 *
 * The cap above exists because pixels captured and then thrown away by
 * `drawImage` on the main thread are what the PR #64 stutter was made of. It
 * has to RISE at 1080p, for the mirror-image reason: a 1280x720 capture drawn
 * into a 1080-wide slot is a 720p chart upscaled, which is the label-only 1080p
 * this change exists to not ship. The chart source must carry the detail the
 * frame is now large enough to hold.
 *
 * That is a real cost and it is measured rather than assumed — see the paint
 * budget note on COMPOSITE_FRAME_RATE and the [composite] summary line that
 * reports p50/p95 against it five seconds into every share.
 */
export function screenCaptureCapFor(quality: BroadcastQuality): {
  width: number;
  height: number;
} {
  return quality === '1080p'
    ? { width: SCREEN_CAPTURE_MAX_WIDTH_1080, height: SCREEN_CAPTURE_MAX_HEIGHT_1080 }
    : { width: SCREEN_CAPTURE_MAX_WIDTH, height: SCREEN_CAPTURE_MAX_HEIGHT };
}

/**
 * The most frames a second worth capturing from a screen.
 *
 * 30 rather than COMPOSITE_FRAME_RATE, deliberately. The composite paints at
 * 24 and reads whatever the screen's <video> last decoded, so a source at 30
 * costs a handful of decodes that are never drawn — and a source at 24 would
 * beat against a 24fps paint loop, landing sometimes one frame stale and
 * sometimes two, which is the judder this whole change is about. A ceiling
 * comfortably above the consumer, with no shared divisor to resonate with, is
 * the cheap and correct choice; the expensive thing was 60.
 */
export const SCREEN_CAPTURE_MAX_FRAME_RATE = 30;

/** The whole frame. The screen's slot in `pip` and `screen`, and — with no
 *  screen share at all — the camera-only publish frame. See cameraFilters. */
export const FULL_FRAME: Rect = {
  x: 0,
  y: 0,
  width: COMPOSITE_WIDTH,
  height: COMPOSITE_HEIGHT,
};

/** The arrangements a creator can pick between while sharing. */
export type CompositeLayout = 'split' | 'pip' | 'screen';

/** Which corner the floating face sits in, in `pip`. */
export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** The order the segmented control renders in. Object key order is not a contract. */
export const COMPOSITE_LAYOUT_ORDER: CompositeLayout[] = ['split', 'pip', 'screen'];

export const COMPOSITE_LAYOUT_LABELS: Record<CompositeLayout, string> = {
  split: 'ครึ่ง-ครึ่ง',
  pip: 'จอลอย',
  screen: 'เฉพาะหน้าจอ',
};

export const PIP_CORNER_ORDER: PipCorner[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

export const PIP_CORNER_LABELS: Record<PipCorner, string> = {
  'top-left': 'ซ้ายบน',
  'top-right': 'ขวาบน',
  'bottom-left': 'ซ้ายล่าง',
  'bottom-right': 'ขวาล่าง',
};

/**
 * Where a share starts, every time.
 *
 * Half and half is the one that is never wrong: both pictures are legible, and
 * a creator who does not touch the control still gets a broadcast worth
 * watching. The other two are choices, and a choice nobody made is not a
 * default, it is a surprise.
 */
export const DEFAULT_COMPOSITE_LAYOUT: CompositeLayout = 'split';

/**
 * Bottom right, which is where a floating face goes almost everywhere.
 *
 * It is also the corner least likely to cover anything: a shared chart or
 * document puts its title and toolbars along the top, and a 16:9 share
 * contained in a 9:16 frame leaves its widest empty margins top and bottom
 * anyway. The picker exists because "almost everywhere" is not everywhere.
 */
export const DEFAULT_PIP_CORNER: PipCorner = 'bottom-right';

export function isCompositeLayout(value: unknown): value is CompositeLayout {
  return value === 'split' || value === 'pip' || value === 'screen';
}

export function isPipCorner(value: unknown): value is PipCorner {
  return typeof value === 'string' && (PIP_CORNER_ORDER as string[]).includes(value);
}

/**
 * The floating face in `pip`: 3:4, upright, and small enough to be a corner.
 *
 * 216x288 is 30% of the frame's width. Big enough that a face in it is a
 * person rather than a smudge, small enough that it reads as an overlay on
 * the share rather than a second panel competing with it — which is the
 * difference between จอลอย and ครึ่ง-ครึ่ง. 3:4 rather than the frame's own
 * 9:16 because a head and shoulders in a tall narrow box is mostly wall.
 *
 * These four are the 720p rung's numbers. `pipMetrics` below is where they
 * come from, and it derives them from the frame rather than hardcoding them —
 * a 216px face inset 24px from the edge of a 1080x1920 frame would be a
 * different design, two thirds the size the creator arranged at 720p.
 */
export const PIP_WIDTH = 216;
export const PIP_HEIGHT = 288;

/** The gap between the floating face and the frame's edges. */
export const PIP_INSET = 24;

/** Rounded corners on the floating face, so it reads as laid over the share. */
export const PIP_RADIUS = 12;

/** The share of the frame's width the floating face occupies. 216/720. */
const PIP_WIDTH_RATIO = 0.3;
/** The inset and the corner radius, as fractions of the width. 24/720, 12/720. */
const PIP_INSET_RATIO = 1 / 30;
const PIP_RADIUS_RATIO = 1 / 60;

/** Even, and never zero — these are destination rectangles for an encoder. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * The floating face's box, scaled to the frame it sits in.
 *
 * At 720x1280 this returns exactly the four constants above, which is the point
 * of the ratios: the 1080p frame is the same design at 1.5x — 324x432 inset 36
 * — and not a new one. A creator who arranged จอลอย at 720p and switched rung
 * sees their arrangement, larger.
 */
export function pipMetrics(size: CompositeSize = COMPOSITE_SIZE_720): {
  width: number;
  height: number;
  inset: number;
  radius: number;
} {
  const width = even(size.width * PIP_WIDTH_RATIO);
  return {
    width,
    // 3:4 from the WIDTH, not from the frame's height: the face's own ratio is
    // the thing being preserved, and deriving the height from the frame would
    // stretch it on any frame that was not 9:16.
    height: even((width * 4) / 3),
    inset: Math.round(size.width * PIP_INSET_RATIO),
    radius: Math.round(size.width * PIP_RADIUS_RATIO),
  };
}

/**
 * Where the two pictures go, for a layout and a corner.
 *
 * The whole layout system, as one pure function over two enums: no canvas, no
 * elements, no state. A wrong arrangement is therefore a wrong number rather
 * than a creator squinting at a preview, and switching layouts mid-share is
 * nothing but calling this again — the canvas, the track and the stream are
 * all untouched by it, so the audience sees the new arrangement without a
 * reconnect.
 *
 * `face` is null in `screen`, which is the honest way to say "not drawn": the
 * caller skips the camera entirely rather than drawing it somewhere harmless.
 *
 * THE KEY IS CALLED `screen` AND IT MEANS "THE SECOND SOURCE". It was named
 * when a shared screen was the only thing that could go there; on a phone the
 * same rectangle holds the BACK CAMERA, drawn with `cover` instead of
 * `contain` (see SlotFit). The geometry is identical and deliberately so — the
 * mobile composite is the desktop `split` layout with a different source in
 * the top slot, not a second layout system that has to be kept in step.
 */
export function layoutRects(
  layout: CompositeLayout,
  pipCorner: PipCorner = DEFAULT_PIP_CORNER,
  /** The canvas being painted. Defaults to the 720p rung's frame. */
  size: CompositeSize = COMPOSITE_SIZE_720,
): { screen: Rect; face: Rect | null } {
  const frame = fullFrame(size);

  if (layout === 'screen') {
    return { screen: frame, face: null };
  }

  if (layout === 'pip') {
    // The share gets the whole frame and is CONTAINED in it, so a 16:9 tab
    // lands 720x406 (405 rounded up to even) centred vertically, with the
    // frame's own black above and below — which is exactly the space the
    // floating face then sits in. At 1080p that is 1080x608, the same picture.
    const pip = pipMetrics(size);
    const right = size.width - pip.width - pip.inset;
    const bottom = size.height - pip.height - pip.inset;
    return {
      screen: frame,
      face: {
        x: pipCorner === 'top-right' || pipCorner === 'bottom-right' ? right : pip.inset,
        y: pipCorner === 'bottom-left' || pipCorner === 'bottom-right' ? bottom : pip.inset,
        width: pip.width,
        height: pip.height,
      },
    };
  }

  // 'split'. Half each, and the bottom is defined as "the rest" rather than as
  // a second half computed separately — so the two meet exactly, with no gap
  // and no overlap, whatever the top rounds to.
  const top = Math.round(size.height / 2 / 2) * 2;
  return {
    screen: { x: 0, y: 0, width: size.width, height: top },
    face: { x: 0, y: top, width: size.width, height: size.height - top },
  };
}

/**
 * Fit a source INSIDE a slot, whole, centred. `object-fit: contain`.
 *
 * This is the screen share's rule, and it is the rule because a screen share
 * is information. A 16:9 chart in the 720x640 top slot lands at 720x406 with
 * black above and below it inside the slot; cropping it to fill would cut
 * the price axis off one side and the time axis off the other, which on a
 * trading chart is most of what the viewer came for.
 *
 * The bars are INSIDE the slot only. The published frame is still 9:16
 * edge to edge, so a phone viewer sees no letterbox around the broadcast —
 * only the natural margin around the chart itself, exactly as they would in a
 * TikTok Live.
 *
 * Returns a destination rectangle in canvas pixels. A source with no
 * dimensions yet (a <video> that has not decoded a frame) returns a
 * zero-sized box rather than a NaN one, so a caller that draws it anyway
 * draws nothing.
 */
export function containRect(sourceWidth: number, sourceHeight: number, slot: Rect): Rect {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    return { x: slot.x, y: slot.y, width: 0, height: 0 };
  }

  const scale = Math.min(slot.width / sourceWidth, slot.height / sourceHeight);
  // Even, and never larger than the slot: rounding a value that is already at
  // the slot's edge upward would put a pixel of picture outside it.
  const width = Math.min(slot.width, Math.round((sourceWidth * scale) / 2) * 2);
  const height = Math.min(slot.height, Math.round((sourceHeight * scale) / 2) * 2);

  return {
    x: slot.x + Math.round((slot.width - width) / 2),
    y: slot.y + Math.round((slot.height - height) / 2),
    width,
    height,
  };
}

/**
 * Choose the part of a source that FILLS a slot. `object-fit: cover`.
 *
 * This is the camera's rule, and it is the opposite decision for the opposite
 * reason: a face is not information laid out to the edges, it is a subject in
 * the middle, and black bars around a creator are what the whole layout exists
 * to avoid. A 16:9 webcam covering the 720x640 bottom slot keeps its full
 * height and loses the outer edges of its width — which is background.
 *
 * It is also what the camera-only publish frame uses, covering the whole
 * 720x1280 — see cameraFilters. That is a harder crop, and deliberately so:
 * see the note there.
 *
 * Returns a SOURCE rectangle, in source pixels, to be drawn across the whole
 * slot. That is the same shape the camera-only path uses for digital zoom, and
 * for the same reason: cropping the source keeps the destination — and so the
 * published resolution — constant, whatever the camera or the zoom does.
 *
 * `zoom` composes on top of the cover crop rather than replacing it: 1 is the
 * widest view this slot can show, and above that it is the same centred crop
 * the camera-only path applies. Below 1 is meaningless here (there is no
 * cropping your way to a wider field of view) and is clamped away.
 */
export function coverSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  slot: Rect,
  zoom = 1,
): Rect {
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(slot.height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const slotAspect = slot.width / slot.height;
  const sourceAspect = sourceWidth / sourceHeight;

  // Wider than the slot: keep the full height, crop the width. Taller: the
  // other way round. Equal ratios fall into either branch and crop nothing.
  let width = sourceAspect > slotAspect ? sourceHeight * slotAspect : sourceWidth;
  let height = sourceAspect > slotAspect ? sourceHeight : sourceWidth / slotAspect;

  const factor = Number.isFinite(zoom) && zoom > 1 ? zoom : 1;
  width /= factor;
  height /= factor;

  return {
    x: (sourceWidth - width) / 2,
    y: (sourceHeight - height) / 2,
    width,
    height,
  };
}
