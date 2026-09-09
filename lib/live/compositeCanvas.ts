/**
 * THE TIKTOK-LIVE LAYOUT: a screen on top, a face underneath, one frame out.
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
 * WHY 55/45. The screen is the content — a chart, a platform, a document — and
 * it is landscape, so it needs width more than height; the face is a portrait
 * and reads fine in a shorter box. 55% gives a 16:9 share the largest picture
 * that still leaves the creator big enough to be a person rather than a
 * thumbnail. It is one constant: move it and both slots follow.
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

/** The whole frame. With no screen share at all, the camera-only publish
 *  frame the webcam covers — see cameraFilters. */
export const FULL_FRAME: Rect = {
  x: 0,
  y: 0,
  width: COMPOSITE_WIDTH,
  height: COMPOSITE_HEIGHT,
};

/** How much of the height the screen share gets. See the header. */
export const SCREEN_SLOT_FRACTION = 0.55;

/**
 * The top slot: the screen share.
 *
 * Even height, because the slot is a destination rectangle on a canvas whose
 * frames go to an H.264 encoder and odd dimensions are a thing some encoders
 * refuse. 1280 * 0.55 is 704 exactly, so this rounds nothing today — the
 * rounding is there so that changing SCREEN_SLOT_FRACTION cannot introduce a
 * half-pixel seam between the two slots.
 */
export const SCREEN_SLOT: Rect = {
  x: 0,
  y: 0,
  width: COMPOSITE_WIDTH,
  height: Math.round((COMPOSITE_HEIGHT * SCREEN_SLOT_FRACTION) / 2) * 2,
};

/**
 * The bottom slot: the creator.
 *
 * Defined as "the rest", not as `1 - fraction` computed separately — so the
 * two slots meet exactly, with no gap and no overlap, whatever the fraction is.
 */
export const CAMERA_SLOT: Rect = {
  x: 0,
  y: SCREEN_SLOT.height,
  width: COMPOSITE_WIDTH,
  height: COMPOSITE_HEIGHT - SCREEN_SLOT.height,
};

/**
 * Fit a source INSIDE a slot, whole, centred. `object-fit: contain`.
 *
 * This is the screen share's rule, and it is the rule because a screen share
 * is information. A 16:9 chart in a 720x704 slot lands at 720x405 with black
 * above and below it inside the slot; cropping it to fill instead would cut
 * the price axis off one side and the time axis off the other, which on a
 * trading chart is most of what the viewer came for.
 *
 * The bars are INSIDE the top slot only. The published frame is still 9:16
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
 * to avoid. A 16:9 webcam covering a 720x576 (5:4) slot keeps its full height
 * and loses the outer edges of its width — which is background.
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
