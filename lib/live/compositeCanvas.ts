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
 * THE OUTPUT IS FIXED AT 720x1280, and it is fixed on purpose. Everywhere else
 * in this pipeline the canvas follows the camera — a desktop webcam publishes
 * 1280x720 landscape, a phone publishes whatever upright frame its sensor
 * gave — because the camera's own ratio is the honest one to publish. A
 * composite has no such ratio to inherit: it is a frame we are composing, its
 * shape is a design decision, and the decision is the one the audience is
 * holding. 9:16 fills a phone edge to edge with no bars anywhere, which is the
 * entire point of the layout.
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
 * it: give it a layout and a corner, get back where the two pictures go. Every
 * rectangle in this file is derived from the two dimensions below, so nothing
 * can drift out of the frame, and every one is even — these are destination
 * rectangles on a canvas whose frames reach an H.264 encoder, and odd
 * dimensions are a thing some encoders refuse.
 */

/** A box on the composite canvas, in canvas pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The published composite frame. 9:16, portrait, the audience's own shape. */
export const COMPOSITE_WIDTH = 720;
export const COMPOSITE_HEIGHT = 1280;

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
 */
export const PIP_WIDTH = 216;
export const PIP_HEIGHT = 288;

/** The gap between the floating face and the frame's edges. */
export const PIP_INSET = 24;

/** Rounded corners on the floating face, so it reads as laid over the share. */
export const PIP_RADIUS = 12;

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
 */
export function layoutRects(
  layout: CompositeLayout,
  pipCorner: PipCorner = DEFAULT_PIP_CORNER,
): { screen: Rect; face: Rect | null } {
  if (layout === 'screen') {
    return { screen: FULL_FRAME, face: null };
  }

  if (layout === 'pip') {
    // The share gets the whole frame and is CONTAINED in it, so a 16:9 tab
    // lands 720x406 (405 rounded up to even) centred vertically, with the
    // frame's own black above and below — which is exactly the space the
    // floating face then sits in.
    const right = COMPOSITE_WIDTH - PIP_WIDTH - PIP_INSET;
    const bottom = COMPOSITE_HEIGHT - PIP_HEIGHT - PIP_INSET;
    const left = PIP_INSET;
    const top = PIP_INSET;
    return {
      screen: FULL_FRAME,
      face: {
        x: pipCorner === 'top-right' || pipCorner === 'bottom-right' ? right : left,
        y: pipCorner === 'bottom-left' || pipCorner === 'bottom-right' ? bottom : top,
        width: PIP_WIDTH,
        height: PIP_HEIGHT,
      },
    };
  }

  // 'split'. Half each, and the bottom is defined as "the rest" rather than as
  // a second half computed separately — so the two meet exactly, with no gap
  // and no overlap, whatever the top rounds to.
  const top = Math.round(COMPOSITE_HEIGHT / 2 / 2) * 2;
  return {
    screen: { x: 0, y: 0, width: COMPOSITE_WIDTH, height: top },
    face: { x: 0, y: top, width: COMPOSITE_WIDTH, height: COMPOSITE_HEIGHT - top },
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
