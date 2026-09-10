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
 * `contain` fits the whole source inside the slot and leaves bars where the
 * ratios disagree. `cover` crops the source to the slot's ratio and fills it
 * edge to edge. Both are here because both are right somewhere.
 *
 * A CAMERA IS `cover`, ALWAYS. It is a subject in the middle of a frame, and
 * black bars around a person are the thing this whole layout exists to avoid.
 * That is true of a webcam in the face slot and of a phone's back camera in
 * the top one, and there is nothing for a creator to choose about it.
 *
 * A SHARED SCREEN USED TO BE `contain`, and that is the decision this file
 * reversed — see ScreenFit for the arithmetic. Short version: the rule was
 * written for a slot roughly the source's own shape, the slots here are 9:16,
 * and a 16:9 chart contained in one is a strip of picture in a field of black.
 * `cover` anchored at the price axis is the default now, and `contain` is a
 * control the creator can reach rather than a default they cannot see.
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
 * THE OLD 1280x720 CAP IS GONE, and this is where it was.
 *
 * PR #64 capped `getDisplayMedia` at 1280x720 because a 4K frame downscaled by
 * `drawImage` on the main thread thirty times a second was the stutter. That
 * reasoning was right about the cost and wrong about the fix, and กราฟเต็ม is
 * why: the expensive part is the NUMBER OF SOURCE PIXELS READ PER FRAME, not
 * the size of the surface they came from, and a `cover` crop reads a fraction
 * of the frame. So the cap moves up rather than down — see
 * SCREEN_CAPTURE_MAX_WIDTH_1080 below — and the pixels a wick needs stop being
 * thrown away in the compositor before the composite ever gets a look at them.
 */

/**
 * The FALLBACK cap: 1920x1080, and the largest a 720p composite can use.
 *
 * It was the 1080p rung's cap in PR #65 and is now the floor rather than the
 * ceiling — 1080p asks for the monitor's native frame (see
 * screenCapturePlanFor) and falls back to exactly this when the paint budget
 * says a native capture is too expensive on the machine it is running on.
 *
 * AND IT IS NOW WHAT 720p ASKS FOR TOO, raised from 1280x720. That looks like
 * more work for the cheaper rung and is less: the กราฟเต็ม slot is 720x832, so
 * a `cover` crop reads a 936x1080 REGION of this frame rather than the whole
 * of it, which is fewer source pixels than the 1280x720 whole frame it
 * replaces — and it is a 1.3x downscale into the slot instead of the 1.15x
 * UPSCALE a 1280x720 capture would have been forced into. Fewer pixels read,
 * and none of them invented.
 */
export const SCREEN_CAPTURE_MAX_WIDTH_1080 = 1920;
export const SCREEN_CAPTURE_MAX_HEIGHT_1080 = 1080;

/**
 * The capped capture, for every rung that takes one and for the fallback.
 *
 * No longer a function of the rung — the rung decides whether there is a cap
 * AT ALL (see screenCapturePlanFor), and where there is one it is this. Kept
 * as a function rather than inlined because the two callers that want the
 * numbers, the studio's fallback and the bench, both want them as a pair.
 *
 * That the cost of this is measured rather than assumed is the whole of PR #64
 * and PR #65's inheritance here: see the paint budget note on
 * COMPOSITE_FRAME_RATE, the [composite] summary five seconds into every share,
 * and /dev/live-chart, which measures it against a 2560x1440 source.
 */
export function screenCaptureCapFor(): { width: number; height: number } {
  return { width: SCREEN_CAPTURE_MAX_WIDTH_1080, height: SCREEN_CAPTURE_MAX_HEIGHT_1080 };
}

/**
 * THE CAPTURE CHAIN, AND WHY IT HAD TWO RESAMPLES IN IT.
 *
 * What a creator's monitor hands a browser, and what reaches the encoder,
 * were separated by two independent downscales before this:
 *
 *   2560x1440 monitor
 *     -> getDisplayMedia capped at 1920x1080   (1.33x, in the compositor)
 *     -> drawImage `contain` into a 1080x608 box (1.78x, bilinear, main thread)
 *
 * Each one is a resample, and a 1px candle wick survives neither: at 1.33x it
 * becomes a grey smear across two pixels, and the second pass smears that
 * again into nothing. 11px axis text goes the same way. No bitrate fixes it —
 * the detail was destroyed before the encoder ever saw a frame.
 *
 * What replaces it in กราฟเต็ม is ONE resample, from a source that still has
 * the pixels:
 *
 *   2560x1440 monitor
 *     -> getDisplayMedia at NATIVE resolution   (no resample at all)
 *     -> drawImage of a 1246x1440 source RECT into the 1080x1248 slot
 *        (1.15x, once — against 2.37x for a `contain` of the same frame, and
 *         0.87x on a 1920x1080 monitor, where the crop is UPSCALED and so
 *         nothing at all is thrown away)
 *
 * `screenCapturePlanFor` is which of those a rung asks for. Native at 1080p
 * and above, because that is the rung whose slot is large enough to use the
 * pixels; capped at 1920x1080 at 720p and below, because a 720x832 slot cannot
 * use a 4K frame and reading one costs the paint budget PR #64 was spent
 * buying back.
 *
 * `null` means "ask for nothing" — a MAXIMUM constraint is what a cap is, and
 * the absence of one is how you say native. See lib/live/screenShareCapture.
 */
export type ScreenCapturePlan = { width: number; height: number } | null;

export function screenCapturePlanFor(quality: BroadcastQuality): ScreenCapturePlan {
  return quality === '1080p' ? null : screenCaptureCapFor();
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
export type CompositeLayout = 'split' | 'pip' | 'screen' | 'chartfull';

/**
 * WHERE THE CROP WINDOW SITS, HORIZONTALLY, IN กราฟเต็ม.
 *
 * `cover` on a 16:9 source in a 9:16-ish slot throws width away, and WHICH
 * width it throws away is the whole difference between a usable chart and a
 * useless one. TradingView and MT5 both put the PRICE AXIS on the right and
 * the oldest candles on the left, so cropping from the right — the default
 * everywhere else, because `cover` centres — would cut off the one column of
 * numbers a trader is reading out loud.
 *
 * Right-anchored is therefore the default: keep the axis and the most recent
 * price action, lose the oldest candles, which is the least important part of
 * the picture and the part a viewer on a phone could not read anyway.
 *
 * The other two exist because "rare" is not "never": some platforms and some
 * layouts put the axis on the left, and a creator drawing on the middle of a
 * chart wants the middle. Three buttons answers all of it; a draggable crop
 * window is a different feature.
 */
export type ChartPan = 'left' | 'center' | 'right';

export const CHART_PAN_ORDER: ChartPan[] = ['left', 'center', 'right'];

export const CHART_PAN_LABELS: Record<ChartPan, string> = {
  left: 'ซ้าย',
  center: 'กลาง',
  right: 'ขวา',
};

/** The axis side, which is the right side, on the platforms creators use. */
export const DEFAULT_CHART_PAN: ChartPan = 'right';

export function isChartPan(value: unknown): value is ChartPan {
  return value === 'left' || value === 'center' || value === 'right';
}

/**
 * The share of the frame's HEIGHT the chart gets in กราฟเต็ม.
 *
 * 65/35, and the number came off the TikTok trading lives Por put next to
 * ours. They are all the same shape: the chart edge to edge across roughly two
 * thirds of the height with NO letterbox inside it, the creator's face in the
 * band below. What that buys is pixels per candle — a 1080-wide frame gives
 * the chart 1080x1248 here against 1080x608 of usable picture in ครึ่ง-ครึ่ง,
 * which is 2.05x the area for the same published frame and the same bitrate.
 *
 * 35% is still a real face: 1080x672 is wider than it is tall and larger than
 * the จอลอย box, so the creator reads as a person rather than a thumbnail.
 */
export const CHART_FULL_TOP_RATIO = 0.65;

/** 0 keeps the left edge, 1 the right, 0.5 the middle. See coverSourceRect. */
export function chartPanAnchor(pan: ChartPan): number {
  if (pan === 'left') return 0;
  if (pan === 'center') return 0.5;
  return 1;
}

/** Which corner the floating face sits in, in `pip`. */
export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** The order the segmented control renders in. Object key order is not a contract. */
export const COMPOSITE_LAYOUT_ORDER: CompositeLayout[] = [
  // First, because on a desktop share it is now what a creator starts in and a
  // segmented control whose selected item is third reads as an override.
  'chartfull',
  'split',
  'pip',
  'screen',
];

export const COMPOSITE_LAYOUT_LABELS: Record<CompositeLayout, string> = {
  chartfull: 'กราฟเต็ม',
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
  return (
    value === 'split' || value === 'pip' || value === 'screen' || value === 'chartfull'
  );
}

/**
 * Is this the arrangement that CROPS the share to fill its slot?
 *
 * A predicate rather than `=== 'chartfull'` comparisons scattered across the
 * paint loop, the studio and the bench, because those have to agree about one
 * thing: this is the preset whose top slot is `cover` with a pan, whatever fit
 * the source itself declared.
 *
 * IT IS NOT THE SWITCH FOR โหมดกราฟ'S ENCODER SETTINGS, and the distinction
 * matters. `maintain-resolution`, `contentHint: 'detail'` and the raised
 * ceiling follow the CONTENT — they apply whenever a shared SCREEN is being
 * composited in, because a chart in a ครึ่ง-ครึ่ง box is still a chart and
 * still loses its wicks to a silent downscale.
 *
 * IT NO LONGER DECIDES THE FIT EITHER. It did — กราฟเต็ม was the one preset
 * that cropped — and that is exactly what made the other three unusable: a
 * creator who wanted ครึ่ง-ครึ่ง got a postage stamp and had no way to say
 * otherwise. The fit is `screenSlotFit` now, orthogonal to the preset. What
 * is left here is the 65/35 preset's IDENTITY, for a log line and a label.
 */
export function isChartLayout(layout: CompositeLayout): boolean {
  return layout === 'chartfull';
}

/**
 * ==========================================================================
 * HOW A SHARED SCREEN IS FITTED INTO ITS SLOT — AND WHY IT IS NOW A CHOICE.
 * ==========================================================================
 *
 * `contain` was the silent default for three of the four presets, on the
 * reasoning written on SlotFit: a screen share is information laid out to its
 * own edges, so cropping it cuts the price axis off one side. That reasoning
 * is sound about a slot that has roughly the source's own shape. It is
 * catastrophic about a 9:16 one.
 *
 * The arithmetic, at 1080p, which is what Por screenshotted: a 16:9 share
 * `contain`ed in เฉพาะหน้าจอ's 1080x1920 frame lands 1080x608 — and on a
 * preview a third of the way down a laptop screen that is the ~420x237 strip
 * of chart in a field of black he sent. ครึ่ง-ครึ่ง's 1080x960 slot gives it
 * 1080x608 as well; จอลอย the same. Three of the four presets were therefore
 * publishing a postage stamp, and the one that was not — กราฟเต็ม — was the
 * one PR #68 had already converted to `cover`.
 *
 * So `cover` is the default EVERYWHERE a screen is drawn, with the same
 * right-anchor and the same ซ้าย/กลาง/ขวา pan that กราฟเต็ม proved, and
 * `contain` becomes a control the creator can reach: เห็นทั้งกราฟ, for the
 * creator who genuinely wants the whole chart with its bars.
 *
 * IT IS A PROPERTY OF THE SHARE, NOT OF THE PRESET. Baking `cover` into three
 * presets and `contain` into a fourth is what produced the situation this
 * replaces — a creator who wanted the whole chart had to know which preset
 * silently stopped cropping, and lost the layout they wanted to get it. One
 * toggle, orthogonal to the four presets, is the smaller thing to explain and
 * the smaller thing to get wrong.
 */
export type ScreenFit = 'fill' | 'whole';

export const SCREEN_FIT_ORDER: ScreenFit[] = ['fill', 'whole'];

export const SCREEN_FIT_LABELS: Record<ScreenFit, string> = {
  fill: 'เต็มช่อง',
  whole: 'เห็นทั้งกราฟ',
};

/** Fill the slot. What every screen layout does unless the creator says otherwise. */
export const DEFAULT_SCREEN_FIT: ScreenFit = 'fill';

export function isScreenFit(value: unknown): value is ScreenFit {
  return value === 'fill' || value === 'whole';
}

/**
 * The fit a slot's source is actually drawn with.
 *
 * TWO INPUTS, AND ONLY ONE OF THEM IS THE CREATOR'S. What the source IS
 * decides the shape of the question: a back camera on a phone is a subject in
 * the middle of a frame and is `cover`, always, because black bars down both
 * sides of a person are the thing this layout exists to avoid and no creator
 * ever wants them. A shared SCREEN is the case where both answers are
 * defensible, and so it is the case that gets a control.
 *
 * Pure, and separate from `layoutRects`, because it is orthogonal to it: every
 * preset asks this same question about its top slot, and the answer is the
 * same in all four.
 */
export function screenSlotFit(
  /** 'screen' for a shared surface, 'camera' for a phone's back camera. */
  kind: 'screen' | 'camera',
  preference: ScreenFit = DEFAULT_SCREEN_FIT,
): SlotFit {
  if (kind !== 'screen') return 'cover';
  return preference === 'whole' ? 'contain' : 'cover';
}

/**
 * A source rectangle, forced inside the source that is actually decoded RIGHT
 * NOW.
 *
 * THE ONE THING THAT MUST NEVER BE ASSUMED IS THE SIZE OF THE SOURCE. A
 * display capture changes its dimensions under the composite's feet — a shared
 * window is resized, a shared tab changes zoom, an `applyConstraints` moves a
 * 2560x1440 surface to 1920x1080 — and a rectangle computed from what the
 * `<video>` said a moment ago is then a rectangle describing pixels that no
 * longer exist. `drawImage` is entitled to refuse that, and a refusal inside a
 * paint callback is what stops a broadcast.
 *
 * So every source rect passes through here on its way to `drawImage`, computed
 * from the dimensions read in the SAME frame, and clamped to them. A rect that
 * clamps to nothing comes back zero-sized, which every caller already reads as
 * "draw nothing for this slot" — black, for one frame, and the loop carries on.
 */
export function clampSourceRect(rect: Rect, sourceWidth: number, sourceHeight: number): Rect {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const x = Math.min(Math.max(0, rect.x), sourceWidth);
  const y = Math.min(Math.max(0, rect.y), sourceHeight);
  // The far edge is clamped rather than the width, so a rect that starts
  // inside the source and runs off it keeps the part that is really there.
  const right = Math.min(Math.max(x, rect.x + rect.width), sourceWidth);
  const bottom = Math.min(Math.max(y, rect.y + rect.height), sourceHeight);

  return { x, y, width: right - x, height: bottom - y };
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
    // The share gets the whole frame, and at the default fit it COVERS it —
    // a 16:9 tab cropped to the 9:16 frame, anchored at the price axis, edge
    // to edge. The floating face is then genuinely floating over the picture
    // rather than sitting in the band of black a `contain` used to leave.
    // เห็นทั้งกราฟ puts that band back for a creator who wants it.
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

  if (layout === 'chartfull') {
    /*
      THE TIKTOK GEOMETRY: the chart takes the top 65%, edge to edge.

      Same construction as `split` below — the top is computed, the bottom is
      "the rest" — so the two meet exactly whatever the rounding does. What
      differs is the RATIO and, far more importantly, the FIT: the caller draws
      this slot with `cover` and a pan (see coverSourceRect's `anchorX`), so a
      16:9 share fills 1080x1248 corner to corner instead of landing 1080x608
      in the middle of it with black above and below.

      That is where the pixels come from. Nothing here is a bigger canvas or a
      higher bitrate; it is the same frame, with the part of it that was black
      given to the chart.
    */
    const top = even(size.height * CHART_FULL_TOP_RATIO);
    return {
      screen: { x: 0, y: 0, width: size.width, height: top },
      face: { x: 0, y: top, width: size.width, height: size.height - top },
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
 * เห็นทั้งกราฟ, and only that: this is what a creator gets when they ask to
 * see the whole of what they shared, bars and all. A 16:9 chart in the
 * 720x640 top slot lands at 720x406 with black above and below it inside the
 * slot — every candle present, every axis present, and small.
 *
 * It was the screen share's silent DEFAULT until ScreenFit, on the reasoning
 * that a chart cropped to fill loses its price axis. `coverSourceRect`'s pan
 * is the answer to that objection — the axis is kept because the crop is
 * anchored to it — which is what made the default swappable.
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
  /**
   * WHICH PART OF THE WIDTH SURVIVES THE CROP. 0 is the left edge, 1 the
   * right, 0.5 the centre — which is what `cover` means everywhere else and is
   * therefore the default, so the camera slots and the mobile composite are
   * untouched by this parameter existing.
   *
   * It is here for กราฟเต็ม and for one reason: the price axis. A centred crop
   * of a 16:9 chart into a 9:16-ish slot throws away equal width from both
   * sides, and the right-hand side is where every trading platform puts the
   * numbers a creator is reading out loud. See ChartPan.
   *
   * Vertical is deliberately NOT exposed. A 16:9 source in a taller slot loses
   * width and keeps all of its height, so there is nothing to choose; a source
   * TALLER than its slot (a shared phone screen, a portrait window) crops top
   * and bottom and stays centred, which is right for the same reason a face is.
   */
  anchorX = 0.5,
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

  // Clamped, because an anchor outside 0..1 would place the crop window off
  // the source and drawImage would read pixels that are not there.
  const anchor = Number.isFinite(anchorX) ? Math.min(1, Math.max(0, anchorX)) : 0.5;

  return {
    x: (sourceWidth - width) * anchor,
    y: (sourceHeight - height) / 2,
    width,
    height,
  };
}
