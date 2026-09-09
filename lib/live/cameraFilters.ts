/**
 * The "look" presets a creator can put on their camera.
 *
 * Plain CSS `filter:` strings. No WebGL, no face tracking, no per-pixel
 * JavaScript — which is what keeps them affordable on a machine that is
 * already encoding a broadcast.
 *
 * Two things use these strings, and the difference matters:
 *
 *  - The SETUP PREVIEW puts the string straight on the <video> element's
 *    `filter` style. The compositor does all of it and it costs nothing, and
 *    a CSS filter on an element is supported everywhere — this path has never
 *    been the problem.
 *  - The BROADCAST draws each camera frame onto a canvas and publishes THAT
 *    canvas as the video track. See createFilteredStream below.
 *
 * The broadcast path has TWO implementations of every look, because
 * `ctx.filter` — a canvas property, not the CSS one — does not exist on older
 * WebKit. Where it exists the string above is used directly; where it does not,
 * the same look is rebuilt out of composite blends further down this file. The
 * creator chooses a look, not an implementation, and never learns which ran.
 *
 * The second one is why viewers now see the look. Until this migration the
 * filter was a preview-only effect — a CSS filter styles the element painting
 * a track, it does not touch the track, so what LiveKit encoded was always the
 * raw camera and the UI had to admit it. Redirecting the publisher through a
 * canvas was worth doing here because the go-live path was being rewritten
 * anyway: the frames now reach the encoder already filtered, so they reach the
 * egress filtered, so they reach Bunny filtered.
 */

import {
  COMPOSITE_HEIGHT,
  COMPOSITE_WIDTH,
  DEFAULT_COMPOSITE_LAYOUT,
  DEFAULT_PIP_CORNER,
  FULL_FRAME,
  PIP_RADIUS,
  containRect,
  coverSourceRect,
  isCompositeLayout,
  isPipCorner,
  layoutRects,
} from './compositeCanvas';
import type { CompositeLayout, PipCorner, Rect } from './compositeCanvas';

export const CAMERA_FILTERS = {
  none: { label: 'ปกติ', filter: 'none' },
  warm: { label: 'อบอุ่น', filter: 'sepia(0.3) saturate(1.4) hue-rotate(-10deg) brightness(1.05)' },
  cool: { label: 'เย็น', filter: 'saturate(1.2) hue-rotate(15deg) brightness(1.02) contrast(1.05)' },
  vintage: { label: 'วินเทจ', filter: 'sepia(0.5) saturate(0.8) contrast(1.1) brightness(0.95)' },
  vivid: { label: 'สดใส', filter: 'saturate(1.6) contrast(1.15) brightness(1.05)' },
  bw: { label: 'ขาวดำ', filter: 'grayscale(1) contrast(1.1)' },
} as const;

export type FilterId = keyof typeof CAMERA_FILTERS;

/** The order the chips render in. Explicit, because object key order is not a contract. */
export const FILTER_ORDER: FilterId[] = ['none', 'warm', 'cool', 'vintage', 'vivid', 'bw'];

/** What the setup screen starts on: the camera as it actually is. */
export const DEFAULT_FILTER_ID: FilterId = 'none';

export function isFilterId(value: unknown): value is FilterId {
  return typeof value === 'string' && value in CAMERA_FILTERS;
}

/**
 * The CSS value for a preset, ready for a style prop.
 *
 * Falls back to 'none' rather than throwing: a filter is decoration, and an
 * unknown id should cost a plain picture, never a broken broadcast screen.
 */
export function filterCssFor(id: FilterId | null | undefined): string {
  return id && isFilterId(id) ? CAMERA_FILTERS[id].filter : 'none';
}

export function filterLabelFor(id: FilterId | null | undefined): string {
  return id && isFilterId(id) ? CAMERA_FILTERS[id].label : CAMERA_FILTERS.none.label;
}

/** Shown wherever the presets are, so a creator knows what the audience gets. */
export const BROADCAST_NOTICE = 'ผู้ชมจะเห็นฟิลเตอร์นี้ด้วย';

/**
 * The app's `md` breakpoint, which is what decides a portrait publish frame.
 *
 * VIEWPORT WIDTH, NOT SOURCE ORIENTATION, and the difference is the whole
 * point: a laptop with a 16:9 webcam and a phone held sideways produce the
 * same landscape frame, and only one of them is a desktop broadcast. The same
 * 768px threshold the host layouts use (PRs #49 and #50) — the exact
 * complement of MOBILE_MAX_WIDTH in useIsMobileViewport, which is what decides
 * WHICH host layout renders — so a creator on the desktop layout gets the
 * desktop pipeline.
 *
 * Read ONCE, at capture setup — a creator who drags their window narrower
 * mid-broadcast keeps the mode they started in, because changing it would mean
 * rebuilding the published track and making the audience watch a reconnect.
 */
export function isDesktopBroadcastViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(min-width: 768px)').matches;
}

/**
 * ==================================================================
 * THE SAME LOOKS, FOR A CANVAS THAT CANNOT FILTER.
 * ==================================================================
 *
 * `ctx.filter` is not universal. WebKit shipped it in Safari 18; on every
 * iPhone below that the property is simply absent, and assigning to an absent
 * property in non-strict JS is a silent no-op — which is exactly what a
 * creator reported: the look chips worked on desktop and did nothing at all on
 * a phone, in the preview AND in what the audience received.
 *
 * It was invisible for so long because nothing failed. No exception, no
 * warning, no fallback: the canvas just kept drawing the raw camera while the
 * UI said อบอุ่น.
 *
 * So each look has a SECOND recipe, built from globalCompositeOperation
 * blends, which every browser this app supports has had for a decade. The
 * frame is drawn once and then painted over two or three times with flat
 * colours; there is no per-pixel JavaScript anywhere in here. `getImageData`
 * would be the obvious way to write a colour grade and it is precisely the
 * wrong one — it stalls the GPU pipeline to read pixels back into JS, on every
 * frame, on the device that has the least headroom.
 *
 * These are APPROXIMATIONS, tuned by measurement rather than by eye (see the
 * side-by-side bench at /dev/camera-looks). A soft-light wash is not a
 * hue-rotate. What they have to be is recognisably the same look, in the same
 * direction, at roughly the same strength — a warm that warms, a ขาวดำ with no
 * colour left in it.
 */

/** One paint over the finished frame. */
type LookPass =
  /** A flat colour across the whole frame. */
  | { kind: 'solid'; composite: GlobalCompositeOperation; color: string }
  /** A radial falloff, dark at the edges. */
  | { kind: 'vignette'; composite: GlobalCompositeOperation; edge: string; mid: string }
  /**
   * The frame blended with ITSELF.
   *
   * The one thing a flat fill cannot do is contrast: `overlay` against a
   * uniform colour lightens or darkens everything, where contrast has to push
   * the dark parts down and the light parts up at the same time. Blending the
   * frame over itself does exactly that, because each pixel's own value is
   * what decides which way it moves — it is the classic darkroom trick, and it
   * is one more GPU draw rather than a pixel loop.
   *
   * This is what makes สดใส and ขาวดำ land: they are `saturate`/`grayscale`
   * PLUS a contrast term, and without this the fallback reproduced the colour
   * change and none of the punch.
   */
  | { kind: 'self'; composite: GlobalCompositeOperation; alpha: number };

/**
 * `saturation` is a non-separable blend: it takes the SATURATION of what is
 * being painted and keeps the hue and luminosity underneath. Painting a grey —
 * which has no saturation — therefore drains colour out of the frame, and the
 * alpha decides how much. That is the whole trick behind ขาวดำ and วินเทจ.
 */
const NEUTRAL_GREY = '#808080';

const LOOK_PASSES: Record<FilterId, LookPass[]> = {
  // The camera, untouched. Not an empty effect — no effect.
  none: [],
  warm: [
    { kind: 'solid', composite: 'soft-light', color: 'rgba(255, 150, 60, 0.16)' },
    // Soft-light alone reads as a wash rather than a grade; the overlay pass
    // puts the contrast back into the midtones the way sepia+saturate does.
    { kind: 'solid', composite: 'overlay', color: 'rgba(255, 150, 60, 0.12)' },
    // …and both of those DARKEN, because the tint's blue channel is well below
    // mid grey. The CSS version ends in brightness(1.05). This is that.
    { kind: 'solid', composite: 'soft-light', color: 'rgba(255, 255, 255, 0.18)' },
  ],
  cool: [
    // Kept at full strength deliberately, and it is the one recipe where the
    // measured distance to the CSS version is NOT the thing being minimised.
    // `เย็น` is mostly hue-rotate(15deg), and a flat wash cannot rotate a hue
    // at all — so the two choices were to match the DIRECTION weakly or the
    // STRENGTH honestly. Tuning for distance drove the tint to 0.04, which is
    // a look a creator cannot see they have applied: the original bug, in a
    // new costume. At 0.16 the fallback moves the picture about as far as the
    // CSS version does (4.9 against 4.3 on skin and neutrals), just along a
    // slightly different axis.
    { kind: 'solid', composite: 'soft-light', color: 'rgba(70, 140, 255, 0.16)' },
    { kind: 'solid', composite: 'overlay', color: 'rgba(70, 140, 255, 0.06)' },
  ],
  vintage: [
    // Order matters and this order is the recipe: drain the colour first, then
    // tint what is left, then darken the edges. Tinting before draining would
    // put the sepia through the desaturation and leave grey.
    // 0.45 measures a mean saturation of 39.2 against the CSS version's 39.3 —
    // which is where this started, and the bench is what confirmed it rather
    // than assumed it.
    { kind: 'solid', composite: 'saturation', color: 'rgba(128, 128, 128, 0.45)' },
    { kind: 'solid', composite: 'multiply', color: 'rgba(255, 220, 170, 0.25)' },
    { kind: 'solid', composite: 'soft-light', color: 'rgba(255, 255, 255, 0.08)' },
    // The vignette has NO counterpart in the CSS version, and it is kept
    // anyway — it is what the look was asked for. It is also most of the
    // residual distance between the two columns on the bench, so the number
    // there is not a defect to chase to zero.
    { kind: 'vignette', composite: 'source-over', edge: 'rgba(0, 0, 0, 0.35)', mid: 'rgba(0, 0, 0, 0.06)' },
  ],
  vivid: [
    // สดใส is a SATURATION look, and the first version of this recipe was the
    // one that proved the bench was worth building: white overlay plus a warm
    // soft-light measured a mean saturation of 61.8 where the CSS version
    // measured 92.2 — below the raw camera's own 63.7. A vivid that made the
    // picture very slightly duller.
    { kind: 'solid', composite: 'saturation', color: 'rgba(255, 0, 0, 0.8)' },
    { kind: 'self', composite: 'overlay', alpha: 0.45 },
    { kind: 'solid', composite: 'overlay', color: 'rgba(255, 255, 255, 0.06)' },
    { kind: 'solid', composite: 'soft-light', color: 'rgba(255, 230, 200, 0.02)' },
  ],
  bw: [
    // Full alpha: ขาวดำ means no colour, not less colour.
    { kind: 'solid', composite: 'saturation', color: NEUTRAL_GREY },
    // grayscale(1) contrast(1.1) — the contrast half, which a white overlay
    // could only fake by making the whole frame lighter.
    { kind: 'self', composite: 'overlay', alpha: 0.2 },
  ],
};

/**
 * Does this browser's 2D context actually apply `ctx.filter`?
 *
 * Two questions, because either one alone gives a wrong answer:
 *
 *  - IS THE PROPERTY THERE? `'filter' in CanvasRenderingContext2D.prototype`
 *    is false on the WebKit versions that never implemented it, and the
 *    assignment those browsers ignore is the actual bug.
 *  - DOES IT KEEP WHAT IT IS GIVEN? Checked by reading it back, and checked
 *    for "not none" rather than for equality — browsers normalise the string
 *    (`grayscale(1)` may come back as `grayscale(100%)`), and an equality test
 *    would call a perfectly good desktop browser broken and switch it onto the
 *    approximate path for nothing.
 *
 * Cached: the answer cannot change within a page, and this allocates a canvas.
 */
let canvasFilterSupport: boolean | null = null;

export function supportsCanvasFilter(): boolean {
  if (canvasFilterSupport !== null) return canvasFilterSupport;
  if (typeof document === 'undefined' || typeof CanvasRenderingContext2D === 'undefined') {
    // SSR. Nothing is drawing here; the real answer is decided in the browser.
    return false;
  }
  if (!('filter' in CanvasRenderingContext2D.prototype)) {
    canvasFilterSupport = false;
    return false;
  }
  try {
    const probe = document.createElement('canvas').getContext('2d');
    if (!probe) {
      canvasFilterSupport = false;
      return false;
    }
    probe.filter = 'grayscale(1)';
    canvasFilterSupport = probe.filter !== 'none' && probe.filter !== '';
  } catch {
    canvasFilterSupport = false;
  }
  return canvasFilterSupport;
}

/** Which of the two paths a stream is using. Surfaced in the debug chip. */
export type LookMode = 'filter' | 'composite';

/**
 * A vignette is a gradient, and a gradient is an allocation — so it is built
 * once per canvas SIZE and kept, not rebuilt on every frame. The size is the
 * cache key because the canvas follows the camera and a front/back flip can
 * change it mid-broadcast.
 */
interface VignetteCache {
  width: number;
  height: number;
  gradient: CanvasGradient;
}

function vignetteFor(
  ctx: CanvasRenderingContext2D,
  pass: Extract<LookPass, { kind: 'vignette' }>,
  cache: VignetteCache | null,
): VignetteCache {
  const { width, height } = ctx.canvas;
  if (cache && cache.width === width && cache.height === height) return cache;

  const cx = width / 2;
  const cy = height / 2;
  // The outer radius reaches the CORNERS, so the darkening is even all the way
  // round instead of stopping short on the long axis of a portrait frame.
  const outer = Math.hypot(cx, cy);
  const gradient = ctx.createRadialGradient(cx, cy, outer * 0.45, cx, cy, outer);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(0.6, pass.mid);
  gradient.addColorStop(1, pass.edge);
  return { width, height, gradient };
}

/**
 * Paint a look over a frame that is already on the canvas.
 *
 * Exported so the comparison bench can drive this path directly on a browser
 * whose `ctx.filter` works — otherwise the fallback could only ever be looked
 * at on the phones that need it, which is not a place you can iterate.
 *
 * Returns the vignette cache to hand back next frame. The context is left as
 * it was found: composite back to source-over, alpha back to 1.
 */
export function applyLookPasses(
  ctx: CanvasRenderingContext2D,
  id: FilterId,
  cache: VignetteCache | null = null,
): VignetteCache | null {
  const passes = LOOK_PASSES[id] ?? [];
  if (passes.length === 0) return cache;

  const { width, height } = ctx.canvas;
  let nextCache = cache;

  ctx.save();
  for (const pass of passes) {
    ctx.globalCompositeOperation = pass.composite;

    if (pass.kind === 'self') {
      // Drawing a canvas onto itself is legal and the browser handles the
      // overlap; globalAlpha is what makes it a partial contrast push rather
      // than a doubling.
      ctx.globalAlpha = pass.alpha;
      ctx.drawImage(ctx.canvas, 0, 0);
      ctx.globalAlpha = 1;
      continue;
    }

    if (pass.kind === 'vignette') {
      nextCache = vignetteFor(ctx, pass, nextCache);
      ctx.fillStyle = nextCache.gradient;
    } else {
      ctx.fillStyle = pass.color;
    }
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();

  return nextCache;
}

/**
 * A camera stream with the look burned into its frames.
 *
 * `publishStream` is what gets published. Its video track comes from a canvas that
 * this module redraws once per camera frame with `ctx.filter` set; its audio
 * tracks are the SOURCE's, passed through untouched — canvas.captureStream()
 * produces video only, and forgetting to carry the audio across is the classic
 * way to ship a silent broadcast.
 *
 * `setFilter` swaps the look mid-broadcast with no republish: the track is the
 * canvas, and the canvas does not care what is being drawn onto it. That is
 * the whole reason the look is changeable from the broadcast bottom bar.
 *
 * COST: one draw per camera frame for the length of the broadcast — two where
 * a portrait publish frame is being produced, which is desktop only, on the
 * machine that has the headroom. That is real, and it is why /creator/live
 * tells creators to broadcast from a computer. `requestVideoFrameCallback` is
 * used where available so the loop runs at the CAMERA's rate (30fps) rather
 * than the display's — on a 120Hz screen a requestAnimationFrame loop would do
 * four times the work for the same output.
 */
export interface FilteredStream {
  /**
   * Show this to the CREATOR. The camera's own frame, whole, never cropped.
   *
   * Video only where it is a canvas of its own — a self-view is muted anyway,
   * and an unmuted one is a feedback loop.
   */
  previewStream: MediaStream;
  /**
   * PUBLISH this. Video from the canvas, audio from the source.
   *
   * The same object as `previewStream` unless the caller asked for a portrait
   * publish frame (see `portrait`), in which case it is a second canvas, fixed
   * at 720x1280, that the camera covers. Callers do not branch on which: they
   * publish this one and preview the other.
   */
  publishStream: MediaStream;
  setFilter: (id: FilterId) => void;
  /**
   * Point the canvas at a DIFFERENT camera, without republishing anything.
   *
   * This is what makes the phone layout's front/back flip free. The published
   * track is the canvas, not the camera — so swapping which camera is drawn
   * onto it is a `srcObject` assignment, invisible to LiveKit, to the egress
   * and to every viewer. Replacing the published track instead would
   * renegotiate, and a renegotiation makes Bunny's ingest reconnect, which the
   * audience sees as a stall.
   *
   * The canvas re-sizes itself to the new camera on the next frame (see the
   * dimension watch in the draw loop), so a front camera that hands back a
   * different aspect ratio than the back one does not squash the picture.
   */
  setSource: (next: MediaStream) => Promise<void>;
  /**
   * Mirror the published frames horizontally, or stop mirroring them.
   *
   * Same deal as setFilter: one variable read by the draw loop, no republish.
   * The flip happens HERE, in the same canvas that applies the look, rather
   * than in a second canvas chained after it — one draw per frame is already
   * the expensive part of this pipeline and doubling it to turn a picture
   * around would be absurd.
   */
  setFlipped: (flipped: boolean) => void;
  /**
   * Digital zoom: draw a centred sub-rectangle of the camera across the whole
   * canvas.
   *
   * 1 means the full frame — the field of view the browser gave, like the
   * native camera app — and nothing is cropped at 1. This is the FALLBACK
   * path: where the camera exposes a real zoom capability the caller drives
   * that instead (see applyZoomConstraint) and leaves this at 1, because
   * hardware zoom keeps the sensor's full resolution while this throws pixels
   * away.
   *
   * The OUTPUT size never changes — the canvas stays the track's dimensions,
   * so a 2x zoom publishes 720x1280 of a 360x640 crop rather than publishing a
   * smaller frame. Softer, which is what digital zoom is; never a resolution
   * change mid-broadcast, which would renegotiate.
   *
   * The creator's self-view IS this canvas, so preview and broadcast cannot
   * show different crops.
   */
  setZoom: (zoom: number) => void;
  /**
   * Composite a SCREEN SHARE above the camera, or stop compositing.
   *
   * This is the TikTok-Live layout, and it is a mode of the same canvas rather
   * than a second pipeline: pass a display stream and the next frame is drawn
   * 720x1280 in whichever arrangement the creator has chosen — see
   * setCompositeLayout — and pass null and the frame after that is the
   * camera-only frame. See ./compositeCanvas for the layouts themselves.
   *
   * NOTHING DOWNSTREAM LEARNS ABOUT IT. `publishStream` is the same object,
   * carrying the same track, from the same canvas — so there is no
   * replaceTrack, no renegotiation, no ICE restart and no reconnect for the
   * audience. The canvas changes SIZE when the mode changes, which a canvas
   * capture track reports as a resolution change; WebRTC adapts to those
   * in-band, the way it already does when a creator flips to a camera with a
   * different sensor ratio.
   *
   * The preview canvas composites too, deliberately: a creator arranging a
   * chart and their own face needs to see the frame the audience gets, and a
   * self-view showing only the camera would leave them guessing where the
   * split lands, and a creator arranging จอลอย needs to see which corner they
   * just put themselves in. This is the one thing the camera-only publish
   * frame does NOT mirror to the preview — see `portrait` — because there the
   * two differ only in how much of the width survives.
   */
  setScreenSource: (next: MediaStream | null) => Promise<void>;
  /**
   * Arrange the composite: which preset, and which corner the จอลอย face sits
   * in.
   *
   * Free, and free for the same reason setFilter is: these are two variables
   * the paint loop reads, so the next frame is simply drawn somewhere else.
   * No replaceTrack, no renegotiation, no reconnect — and since Fix 2 not even
   * an in-band resize, because the publish canvas is 720x1280 in every desktop
   * mode. A creator can flip between ครึ่ง-ครึ่ง, จอลอย and เฉพาะหน้าจอ as
   * often as they like and the audience just sees the picture rearrange.
   *
   * Takes effect whether or not a share is running: paintComposite reads these
   * when it next runs, so a layout chosen and then a share started comes up in
   * the layout that was chosen.
   *
   * `pipCorner` is optional because the corner is a property of จอลอย alone —
   * omitting it changes the preset and leaves the corner where the creator
   * last put it.
   */
  setCompositeLayout: (layout: CompositeLayout, pipCorner?: PipCorner) => void;
  /**
   * What the pipeline is actually doing, for the ?debug=camera chip.
   *
   * `lookMode` says which of the two look implementations this stream picked,
   * which is the one thing you cannot see by looking at the picture — a look
   * that renders correctly through composite passes and a look that renders
   * correctly through ctx.filter are, when it works, indistinguishable.
   *
   * `fps` is the DRAW rate measured over the last full second, not the rate
   * the canvas was asked to capture at. The composite passes are what makes
   * that worth showing: they are cheap, but "cheap" is a claim, and this is
   * the number that settles it on the phone in the creator's hand.
   */
  getStats: () => {
    fps: number;
    lookMode: LookMode;
    /** True where the publish canvas is the fixed 9:16 frame. Desktop only. */
    portrait: boolean;
    /** True while a screen share is being composited in. See setScreenSource. */
    compositing: boolean;
    /** The creator's chosen arrangement. Only meaningful while compositing. */
    layout: CompositeLayout;
    pipCorner: PipCorner;
  };
  /** Stops the draw loop and the canvas track. Does NOT stop the source. */
  stop: () => void;
}

/**
 * How large a published frame may be, when a caller states a cap.
 *
 * A phone that is asked for nothing (which is the fix for the zoom — see
 * lib/live/cameraCapture.ts) hands back a full sensor mode, and 4032x3024 is
 * not something to encode, push over RTMP and pay a CDN for. The whole frame is
 * scaled DOWN to fit, keeping its ratio: no crop, no lost field of view, just
 * fewer pixels.
 *
 * Deliberately NOT applied by re-constraining the track. iOS may satisfy a
 * size constraint by cropping the sensor again, which is the bug this is
 * downstream of.
 */
export async function createFilteredStream(
  source: MediaStream,
  initialFilter: FilterId,
  frameRate = 30,
  initialFlipped = false,
  /** Longest published edge, in px. Omitted on desktop, which is unchanged. */
  maxLongEdge?: number,
  /**
   * Publish a fixed 9:16 frame that the camera COVERS. Desktop only.
   *
   * Omitted (or false) is the single-canvas pass-through this pipeline has
   * always been — one canvas, published and previewed, at the camera's own
   * ratio. True builds a SECOND canvas, 720x1280, with the webcam's full
   * height kept and its outer width cropped away, and leaves the creator's
   * preview at the full un-cropped frame.
   */
  portrait?: boolean,
): Promise<FilteredStream> {
  const [sourceVideoTrack] = source.getVideoTracks();
  if (!sourceVideoTrack) throw new Error('No video track to filter');

  const settings = sourceVideoTrack.getSettings();
  const width = settings.width ?? 1280;
  const height = settings.height ?? 720;

  // A detached <video> is the only way to get decodable frames out of a
  // MediaStreamTrack that drawImage will accept. It is never added to the
  // document — muted and playsInline so autoplay policies leave it alone.
  const video = document.createElement('video');
  video.srcObject = new MediaStream([sourceVideoTrack]);
  video.muted = true;
  video.playsInline = true;
  await video.play();

  /**
   * A canvas this pipeline paints, and how much of that canvas the picture
   * fills.
   *
   * ONE VIDEO SOURCE, ONE FRAME CALLBACK, UP TO TWO TARGETS. `scale` is the
   * only thing that differs between them: 1 draws the camera across the whole
   * canvas — the frame this pipeline has always produced — and anything below
   * it draws the same frame smaller and centred, with black filling the rest.
   */
  interface PaintTarget {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    /**
     * False follows the CAMERA's own ratio — the preview, and every phone.
     * True is the fixed 9:16 publish frame the camera covers.
     */
    portrait: boolean;
    /** Per target: a vignette gradient is built for one canvas, and a clipped one differs. */
    vignette: VignetteCache | null;
  }

  const createTarget = (portrait: boolean): PaintTarget => {
    const canvas = document.createElement('canvas');
    canvas.width = portrait ? COMPOSITE_WIDTH : width;
    canvas.height = portrait ? COMPOSITE_HEIGHT : height;
    // `alpha: false` — the camera has no transparency, and telling the browser
    // so lets it skip compositing work on every single frame.
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    return { canvas, ctx, portrait, vignette: null };
  };

  /**
   * What the creator watches. Full-frame, always.
   *
   * This is the whole reason there are two canvases rather than one cropped
   * canvas shown in both places: the creator's self-view must keep looking
   * exactly like their camera, showing everything it can see. Cropping it is
   * a change nobody asked for and it makes framing a shot harder, not easier
   * — a creator cannot tell they are drifting out of the published frame if
   * their preview is cropped the same way. It was the lesson of the closed
   * PR #56 and it still holds.
   */
  const preview = createTarget(false);

  /**
   * What the audience gets on a desktop broadcast, and null everywhere else.
   *
   * A fixed 720x1280 that the webcam COVERS — full height, outer width cropped,
   * centred — so a phone viewer gets a face edge to edge instead of a small
   * one in a field of black. On a phone this is null, the published track IS
   * the preview canvas, and PR #50's "publish the sensor's own frame" path is
   * untouched: a phone sensor already gives an upright frame and has nothing
   * to crop.
   *
   * 720x1280 is the COMPOSITE's size on purpose. A creator toggling a share on
   * and off no longer resizes the published canvas at all — there is not even
   * an in-band resolution change for the audience to ride out.
   */
  const portraitPublish = portrait === true ? createTarget(true) : null;

  /** Painted in order, from one paint. Preview first — see paintAllTargets(). */
  const targets: PaintTarget[] = portraitPublish ? [preview, portraitPublish] : [preview];

  let currentFilter = initialFilter;
  let currentFlipped = initialFlipped;
  let currentZoom = 1;
  /**
   * The screen share, when there is one, and whether to draw it.
   *
   * A SECOND detached <video>, built lazily and only where a creator actually
   * shares something — the overwhelming majority of broadcasts never allocate
   * it. `compositing` is a separate flag rather than a null check on the
   * element, because the element is kept across a stop/start cycle (see
   * setScreenSource) and "there is an element" and "draw the composite" stop
   * being the same question the moment it is.
   */
  let screenVideo: HTMLVideoElement | null = null;
  let compositing = false;
  /**
   * The creator's chosen arrangement, and where the floating face sits.
   *
   * Plain variables read by paintComposite every frame, exactly like the look
   * and the mirror before them — which is what makes switching layouts free:
   * the published track is the canvas, and the canvas does not care what is
   * being drawn onto it.
   *
   * They survive a share being stopped and restarted, because they live for
   * as long as this pipeline does. They do NOT survive the broadcast: a new
   * broadcast builds a new pipeline and starts at the defaults again.
   */
  let currentLayout: CompositeLayout = DEFAULT_COMPOSITE_LAYOUT;
  let currentPipCorner: PipCorner = DEFAULT_PIP_CORNER;
  let running = true;
  let rafId: number | null = null;
  let frameCallbackId: number | null = null;
  /**
   * The ticker that keeps painting when nothing else will. See startTicker.
   *
   * Null where a Worker or a Blob URL cannot be built — an old browser, a
   * Content-Security-Policy with no `worker-src blob:`. There the loop is
   * exactly what it was before: rVFC while visible, frozen while hidden. A
   * missing optimisation, not a broken broadcast.
   */
  let ticker: Worker | null = null;
  let tickerUrl: string | null = null;
  /**
   * Re-entrancy guard. Two painters now feed one canvas — rVFC and the worker
   * — and a tick that lands mid-paint must be dropped rather than queued: the
   * next one is 33ms away and painting the same decoded frame twice buys
   * nothing but contention.
   */
  let painting = false;
  /**
   * When the last frame was painted, by either painter.
   *
   * The ticker's SAFETY NET, not its normal signal — see the tick handler.
   * Visibility decides which painter is in charge; this catches the case
   * visibility cannot describe, a frame callback that has quietly stopped
   * arriving in a tab that still calls itself visible.
   */
  let lastPaintAt = 0;

  /*
    WHICH LOOK IMPLEMENTATION THIS STREAM USES, decided ONCE.

    Not per frame, and not per look change: the answer is a property of the
    browser, it cannot change while the page is open, and re-deciding it inside
    the draw loop would put a branch and a property read on the hot path for a
    constant.

    Desktop lands on 'filter' and is bit-for-bit unchanged by any of this.
  */
  const lookMode: LookMode = supportsCanvasFilter() ? 'filter' : 'composite';

  // The measured draw rate — see getStats. A counter and a window, because a
  // per-frame delta reads as noise on a phone and what anyone actually wants
  // to know is whether this is holding 30 or dropping to 12.
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let framesThisWindow = 0;
  let windowStartedAt = now();
  let measuredFps = 0;

  console.info(`[camera] look mode: ${lookMode}`);
  if (portraitPublish) {
    console.info(`[camera] publishing ${COMPOSITE_WIDTH}x${COMPOSITE_HEIGHT}, camera covering`);
  }

  /**
   * One target, one frame.
   *
   * Everything that used to be the body of `draw` lives here, because every
   * line of it — the size watch, the mirror, the zoom crop, the look — has to
   * happen identically on both canvases. The ONLY difference between a preview
   * paint and a publish paint is the destination rectangle computed below.
   */
  const paintFrame = (target: PaintTarget) => {
    const { canvas, ctx, portrait: isPortrait } = target;

    if (isPortrait) {
      /*
        THE PORTRAIT PUBLISH FRAME: a fixed 9:16 the camera fills.

        Fixed rather than followed, which is the opposite of the branch below
        and the whole of Fix 2. A desktop webcam is 16:9 and the audience is on
        a phone; publishing the webcam's own ratio meant a viewer got a band of
        picture across the middle of their screen and black everywhere else.
        PR #61 made that worse before it made it better — it drew the camera at
        75% inside the landscape frame, so the face ended up small AND boxed.

        The same size as a composite, so toggling a share on and off does not
        resize the published canvas at all.
      */
      if (canvas.width !== COMPOSITE_WIDTH || canvas.height !== COMPOSITE_HEIGHT) {
        canvas.width = COMPOSITE_WIDTH;
        canvas.height = COMPOSITE_HEIGHT;
        target.vignette = null;
      }
    } else {
      /*
        THE CANVAS IS THE SIZE OF THE CAMERA, ALWAYS, AND IT IS CHECKED EVERY
        FRAME.

        This is what makes a phone publish PORTRAIT, and what keeps the
        creator's own preview showing their camera exactly as it is.
        `getSettings()` above is read once, before the track has necessarily
        settled, and on iOS Safari it is frequently the landscape figure that
        was ASKED for rather than the portrait one the camera actually
        produces. A canvas fixed at that first answer then gets
        `drawImage(video, 0, 0, 1280, 720)` — which does not letterbox, it
        STRETCHES — so a 720x1280 portrait camera was being squashed into a
        landscape frame and published that way.

        `videoWidth`/`videoHeight` are the decoded frame's real dimensions, so
        following them fixes that and three other things for free: a camera
        that settles a moment after `play()`, a phone rotated mid-broadcast,
        and the front/back flip in setSource handing over a different aspect
        ratio.

        Writing to canvas.width resets the whole 2D context, so it is guarded
        on an actual change — doing it every frame would clear the filter and
        the transform below on every frame.
      */
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        // The camera's own ratio, capped in SIZE only where the caller asked
        // for a cap. Rounded to even numbers because some encoders reject odd.
        const longest = Math.max(video.videoWidth, video.videoHeight);
        const capScale = maxLongEdge && longest > maxLongEdge ? maxLongEdge / longest : 1;
        const nextWidth = Math.round((video.videoWidth * capScale) / 2) * 2;
        const nextHeight = Math.round((video.videoHeight * capScale) / 2) * 2;
        if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
          canvas.width = nextWidth;
          canvas.height = nextHeight;
          // The vignette gradient is built for one canvas size. applyLookPasses
          // checks this too; dropping it here means the check never has to fail.
          target.vignette = null;
        }
      }
    }

    /*
      WHICH PART OF THE CAMERA IS DRAWN, in SOURCE pixels.

      Both branches produce a source rectangle that is then drawn across the
      WHOLE canvas — which is why neither needs a destination box, a padding
      fill or a clip any more. The picture reaches all four edges in both
      modes; there is no longer anywhere on either canvas for a bar to be.

      Preview: the whole frame at zoom 1 — the full field of view, scaled but
      never cropped — and a centred sub-rect above it.

      Portrait publish: `cover`, the same rule and the same function the
      composite's camera slot uses, so the two modes crop a face identically
      and toggling a share does not reframe the creator. Zoom composes on top
      of the cover crop rather than replacing it, exactly as it does there.

      THE TRADE, stated plainly: a 16:9 webcam covered into 9:16 keeps only
      the centre ~32% of its width. A creator sitting well off to one side
      will be partly out of frame. That is what the mirror and digital-zoom
      controls are for today and what a pan control would be for later, and it
      is the same trade every vertical-live platform makes with a desktop
      webcam — the alternative is the field of black this replaces.
    */
    let src: Rect;
    if (isPortrait) {
      src = coverSourceRect(video.videoWidth, video.videoHeight, FULL_FRAME, currentZoom);
    } else {
      const zoom = currentZoom > 1 ? currentZoom : 1;
      const sw = video.videoWidth / zoom;
      const sh = video.videoHeight / zoom;
      src = { x: (video.videoWidth - sw) / 2, y: (video.videoHeight - sh) / 2, width: sw, height: sh };
    }

    // save/restore around the whole paint: both the filter and the transform
    // are drawing state, and a flip that leaked into the next frame would
    // flip it back. Set per frame rather than once, so a look or a flip
    // changed mid-broadcast takes effect on the very next frame.
    ctx.save();
    // Only where it does something. On the composite path this assignment
    // would be the silent no-op that caused the bug, and writing it anyway
    // "just in case" is how it stayed hidden.
    if (lookMode === 'filter') ctx.filter = filterCssFor(currentFilter);
    if (currentFlipped) {
      // Move the origin to the right edge, then draw leftwards. Scaling
      // without the translate would put the picture off-canvas.
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    // Guarded on the element having decoded something. drawImage throws
    // IndexSizeError on a zero-sized source rect, and the worker ticker makes
    // that reachable for the first time: it starts on a timer and can fire
    // before the camera has produced a frame, where a frame callback by
    // definition could not. The canvas is opaque black until then.
    if (src.width > 0 && src.height > 0) {
      ctx.drawImage(video, src.x, src.y, src.width, src.height, 0, 0, canvas.width, canvas.height);
    }
    ctx.restore();

    /*
      THE LOOK, ON THE BROWSERS THAT CANNOT FILTER — and note WHERE it is.

      After the restore, so it runs in plain canvas coordinates: the passes
      cover the whole frame, and painting them through the mirror transform
      would flip a vignette that is symmetrical anyway while making the code
      lie about what it depends on.

      After the draw, every frame, which is what makes requirement 4 fall out
      for free rather than needing handling: the zoom crop, the front/back
      flip and a camera that resized mid-broadcast have all already happened by
      the time these run, so a look survives all three without knowing they
      exist.

      No clip on either target now. The picture fills the canvas in both modes,
      so "the picture" and "the canvas" are the same region, and the clip the
      padded frame used to need has nothing left to exclude.
    */
    if (lookMode === 'composite') {
      target.vignette = applyLookPasses(ctx, currentFilter, target.vignette);
    }
  };

  /**
   * One target, one frame, in COMPOSITE mode.
   *
   * The sibling of paintFrame above, and the split is deliberate: the
   * camera-only path is about publishing ONE source, following its ratio on
   * the preview and covering a fixed frame on the publish canvas, and none of
   * that survives contact with a frame that has two sources and an
   * arrangement chosen by the creator. Branching inside paintFrame would have
   * meant a conditional on nearly every line of it; two functions with one
   * branch between them is the smaller thing to read and the smaller thing to
   * get wrong.
   *
   * `target.portrait` is ignored here, and that is the design: this frame is
   * 720x1280 for BOTH targets, so the preview and the publish canvas paint
   * identical pictures while this runs — which is what makes the studio
   * WYSIWYG, and what lets a creator arrange จอลอย and see where it lands.
   */
  const paintComposite = (target: PaintTarget) => {
    const { canvas, ctx } = target;

    /*
      THE CANVAS IS THE COMPOSITE'S OWN SIZE.

      Same guard as the camera-only path and for the same reason — writing to
      canvas.width resets the 2D context. On the publish canvas this is now a
      no-op: since Fix 2 that canvas is already 720x1280 in camera-only mode,
      so starting and stopping a share changes NOTHING about the published
      track's dimensions. Only the preview, which follows the camera, actually
      resizes here.
    */
    if (canvas.width !== COMPOSITE_WIDTH || canvas.height !== COMPOSITE_HEIGHT) {
      canvas.width = COMPOSITE_WIDTH;
      canvas.height = COMPOSITE_HEIGHT;
      target.vignette = null;
    }

    // The creator's arrangement, read fresh every frame — which is all
    // "switching layout mid-share" amounts to. Nothing is rebuilt, nothing is
    // renegotiated, and the next frame out is simply drawn somewhere else.
    const rects = layoutRects(currentLayout, currentPipCorner);

    /*
      Black, every frame, before anything is drawn.

      Load-bearing, not belt-and-braces. A contained screen share leaves real
      margin inside its slot whenever the shared surface is not the slot's
      ratio — which is always — a tab resized mid-share moves where that
      margin falls, and a creator moving the จอลอย face from one corner to
      another leaves the old corner behind. Without this, the previous frame's
      picture stays wherever the new one no longer covers.
    */
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    /*
      THE SCREEN: whole, and untouched.

      No look, no mirror, no zoom, and each omission is a decision rather than
      an oversight. A look is a portrait grade — a warm wash over a candlestick
      chart is a chart with the wrong colours, and ขาวดำ over one is a chart a
      viewer cannot read at all. A mirror would reverse text. Zoom is a camera
      framing control and the creator already chose their framing when they
      picked what to share.
    */
    const screen = screenVideo;
    if (screen && screen.videoWidth > 0 && screen.videoHeight > 0) {
      const box = containRect(screen.videoWidth, screen.videoHeight, rects.screen);
      if (box.width > 0 && box.height > 0) {
        ctx.drawImage(screen, box.x, box.y, box.width, box.height);
      }
    }

    /*
      THE FACE, filling its rect, with everything that applies to a camera
      still applying — or not drawn at all in เฉพาะหน้าจอ, where `face` is
      null and the creator has said they want to be out of the way.

      Clipped first, then transformed, then drawn — the clip is set while the
      transform is still identity so it stays in canvas coordinates, and a
      mirror inside it maps the rect onto itself instead of sliding the
      picture sideways.
    */
    const face = rects.face;
    if (face && video.videoWidth > 0 && video.videoHeight > 0) {
      const src = coverSourceRect(video.videoWidth, video.videoHeight, face, currentZoom);

      ctx.save();
      ctx.beginPath();
      // Rounded in จอลอย, where the face is laid OVER the share and a hard
      // rectangle reads as a hole punched in it. Square in ครึ่ง-ครึ่ง, where
      // it is a panel meeting the screen's edge and a rounded corner there
      // would just show black. roundRect is guarded because it is newer than
      // this pipeline's floor; a square pip is a cosmetic loss, not a broken
      // frame.
      if (currentLayout === 'pip' && typeof ctx.roundRect === 'function') {
        ctx.roundRect(face.x, face.y, face.width, face.height, PIP_RADIUS);
      } else {
        ctx.rect(face.x, face.y, face.width, face.height);
      }
      ctx.clip();
      if (lookMode === 'filter') ctx.filter = filterCssFor(currentFilter);
      if (currentFlipped) {
        // Reflect about the rect's own vertical centre line, so a mirrored
        // face stays in its corner instead of jumping across the frame.
        ctx.translate(face.x * 2 + face.width, 0);
        ctx.scale(-1, 1);
      }
      if (src.width > 0 && src.height > 0) {
        ctx.drawImage(video, src.x, src.y, src.width, src.height, face.x, face.y, face.width, face.height);
      }
      ctx.restore();

      // The look, on the browsers that cannot filter — clipped to the face for
      // the same reason the draw is: unclipped, a วินเทจ vignette would darken
      // the corners of the chart. Reachable only where `ctx.filter` is
      // missing, which is a phone, which has no getDisplayMedia — so this is
      // correctness kept honest rather than a path anyone runs today.
      if (lookMode === 'composite') {
        ctx.save();
        ctx.beginPath();
        ctx.rect(face.x, face.y, face.width, face.height);
        ctx.clip();
        target.vignette = applyLookPasses(ctx, currentFilter, target.vignette);
        ctx.restore();
      }
    }
  };

  /**
   * Paint every target once. The only thing that actually draws.
   *
   * Called from TWO places now — the frame callback and the worker ticker —
   * which is why the re-entrancy guard and the timestamp live here rather
   * than in either caller: whichever painter runs, the other one can see that
   * it did.
   */
  const paintAllTargets = () => {
    if (!running || painting) return;
    painting = true;
    try {
      // Both canvases from the SAME call, in the same tick, off the same
      // decoded frame — so the creator's preview and the audience's picture can
      // never be a frame apart from each other.
      // One decoded camera frame, read once, painted into every target — and in
      // composite mode the screen's <video> is read in the same tick, so the two
      // sources in a published frame are never a frame apart from each other.
      const paint = compositing ? paintComposite : paintFrame;
      for (const target of targets) paint(target);
    } finally {
      // In a finally so a throw from one target — a canvas whose context was
      // lost, a drawImage on a video that just went away — cannot wedge the
      // guard on and stop the broadcast painting for good.
      painting = false;
    }

    lastPaintAt = now();
    framesThisWindow += 1;
    const at = lastPaintAt;
    if (at - windowStartedAt >= 1000) {
      measuredFps = Math.round((framesThisWindow * 1000) / (at - windowStartedAt));
      framesThisWindow = 0;
      windowStartedAt = at;
    }
  };

  const documentHidden = () =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden';

  /**
   * The frame callback chain: paint, then ask for the next one.
   *
   * This is the OPTIMISATION, not the guarantee. It aligns paints to decoded
   * camera frames, so a visible tab does exactly the work it did before this
   * change and not a frame more. The guarantee is the worker ticker below.
   */
  const onVideoFrame = () => {
    frameCallbackId = null;
    rafId = null;
    if (!running) return;
    paintAllTargets();
    scheduleVideoFrame();
  };

  function scheduleVideoFrame() {
    if (!running) return;
    // Already armed. Reachable when a tab becomes visible again while a
    // callback from before it was hidden is still outstanding; arming a
    // second one would run two chains at once for the rest of the broadcast.
    if (frameCallbackId !== null || rafId !== null) return;
    // Pointless while hidden: Chrome delivers neither rVFC nor rAF to a
    // hidden tab. Not arming there is what makes the visible-again path
    // deterministic rather than dependent on whether the browser chose to
    // flush a callback it had been sitting on.
    if (documentHidden()) return;

    const withFrameCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    if (typeof withFrameCallback.requestVideoFrameCallback === 'function') {
      frameCallbackId = withFrameCallback.requestVideoFrameCallback(onVideoFrame);
      return;
    }
    rafId = requestAnimationFrame(onVideoFrame);
  }

  const cancelVideoFrame = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    const withFrameCallback = video as HTMLVideoElement & {
      cancelVideoFrameCallback?: (id: number) => void;
    };
    if (frameCallbackId !== null) {
      withFrameCallback.cancelVideoFrameCallback?.(frameCallbackId);
      frameCallbackId = null;
    }
  };

  /**
   * ==================================================================
   * WHY A WEB WORKER OWNS THE CLOCK.
   * ==================================================================
   *
   * A creator who shares their screen is, by definition, about to go and look
   * at the thing they shared. They click แชร์หน้าจอ, pick their TradingView
   * tab, switch to it — and the broadcaster tab is now hidden.
   *
   * Chrome delivers `requestVideoFrameCallback` and `requestAnimationFrame`
   * to VISIBLE tabs only. Both stop dead the moment the tab goes to the
   * background. The canvas therefore stops being painted, and a canvas that
   * is not painted is a canvas whose `captureStream` track emits no new
   * frames — so the published track sits on its last painted frame for as
   * long as the creator is away. The audience sees a photograph. That is
   * exactly what was reported: a frozen face, and never the chart.
   *
   * It was never a composite bug. The camera-only path has had it all along —
   * alt-tab away to read chat and the broadcast froze too — it just took
   * screen share, where leaving the tab is the POINT, to make it obvious.
   *
   * `setInterval` on `window` is not the fix, it is the same bug with extra
   * steps: Chrome clamps background window timers to 1Hz, and after five
   * minutes in the background to once a minute. One frame a minute is not a
   * broadcast.
   *
   * WORKER timers are not throttled that way. A worker has no rendering to
   * align to and no visibility of its own, so its interval keeps firing at
   * the rate it was given whatever the tab is doing. It posts a message; the
   * main thread paints. All the worker knows how to do is say "now" 30 times
   * a second, which is the smallest possible thing to put on a second thread.
   */
  const startTicker = () => {
    if (typeof Worker !== 'function' || typeof URL?.createObjectURL !== 'function') {
      console.warn('[camera] no Worker; frames will freeze while the tab is hidden');
      return;
    }

    // The interval is baked into the source rather than posted in afterwards:
    // the worker has no protocol, no state and no message handler, so there
    // is nothing to get out of step with the main thread.
    const source = `let n=0;setInterval(()=>postMessage(++n),${1000 / frameRate});`;

    try {
      const blob = new Blob([source], { type: 'text/javascript' });
      tickerUrl = URL.createObjectURL(blob);
      ticker = new Worker(tickerUrl);
      ticker.onmessage = () => {
        if (!running) return;

        /*
          WHICH PAINTER OWNS THIS TICK.

          Hidden: the ticker, every tick, because nothing else is being
          delivered. That is the fix, and it lands the canvas on the capture
          rate exactly rather than approximately.

          Visible: rVFC, and the ticker returns after one comparison. Note
          what this is NOT — an "has it been a frame interval?" test. The two
          clocks run at the SAME rate, so a tick lands a hair under one
          interval after the paint it follows, every time; a one-interval
          threshold would skip every other tick and hold the loop at half
          rate. That is not hypothetical, it is what the first cut of this did
          and what the bench measured: 15fps.

          So the threshold is TWO intervals, and it is a staleness check
          rather than a dedup: while rVFC is healthy it never trips, and if
          rVFC stops arriving in a tab that still reports itself visible — a
          case visibilitychange cannot tell us about — the ticker picks the
          loop up within two frames instead of leaving the audience on a
          still.
        */
        if (!documentHidden() && now() - lastPaintAt < 2000 / frameRate) return;
        paintAllTargets();
      };
    } catch (err) {
      // A CSP without `worker-src blob:` lands here. Degrade to the old
      // behaviour rather than failing the broadcast over a background-tab
      // optimisation.
      console.warn('[camera] ticker worker unavailable; frames freeze when hidden', err);
      stopTicker();
    }
  };

  function stopTicker() {
    if (ticker) {
      ticker.onmessage = null;
      ticker.terminate();
      ticker = null;
    }
    if (tickerUrl) {
      // The blob is a document-lifetime allocation until this runs, and a
      // creator who stops and restarts a broadcast would leak one per go.
      URL.revokeObjectURL(tickerUrl);
      tickerUrl = null;
    }
  }

  /**
   * Which painter is doing the work, announced once per transition.
   *
   * Nothing branches on this — the dedup above needs no mode — so it is
   * purely so that "did the ticker take over?" is answerable from a console
   * log next to the creator's own screen recording, rather than by inference
   * from a viewer's frozen picture.
   */
  const onVisibilityChange = () => {
    if (!running) return;
    if (documentHidden()) {
      // Cancelled rather than left outstanding: see scheduleVideoFrame.
      cancelVideoFrame();
      console.info('[camera] ticker: worker');
    } else {
      console.info('[camera] ticker: rvfc');
      scheduleVideoFrame();
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  startTicker();
  paintAllTargets();
  scheduleVideoFrame();

  const previewStream = preview.canvas.captureStream(frameRate);
  const publishStream = portraitPublish
    ? portraitPublish.canvas.captureStream(frameRate)
    : previewStream;
  // Audio is not optional here — see the note above. It goes on the PUBLISHED
  // stream: the self-view is muted by definition (an unmuted one is a feedback
  // loop), and where there is no padding these are the same object anyway.
  for (const audioTrack of source.getAudioTracks()) publishStream.addTrack(audioTrack);

  return {
    previewStream,
    publishStream,
    setFilter: (id) => {
      currentFilter = id;
    },
    setFlipped: (flipped) => {
      currentFlipped = flipped;
    },
    getStats: () => ({
      fps: measuredFps,
      lookMode,
      portrait: portraitPublish !== null,
      compositing,
      layout: currentLayout,
      pipCorner: currentPipCorner,
    }),
    setZoom: (zoom) => {
      // Floored at 1: there is no such thing as digital zoom OUT. Widening the
      // field of view needs a different camera, which is the 0.5x ultra-wide
      // device switch and not this.
      currentZoom = Number.isFinite(zoom) && zoom > 1 ? zoom : 1;
    },
    setCompositeLayout: (layout, pipCorner) => {
      const nextLayout = isCompositeLayout(layout) ? layout : DEFAULT_COMPOSITE_LAYOUT;
      const nextCorner = isPipCorner(pipCorner) ? pipCorner : currentPipCorner;
      if (nextLayout === currentLayout && nextCorner === currentPipCorner) return;
      currentLayout = nextLayout;
      currentPipCorner = nextCorner;
      // Logged rather than silent because this is the one control whose effect
      // on the PUBLISHED frame a creator can only confirm by asking a viewer.
      console.info(
        `[composite] layout: ${currentLayout}` +
          (currentLayout === 'pip' ? ` (${currentPipCorner})` : ''),
      );
    },
    setScreenSource: async (next) => {
      if (!next) {
        // The flag first: the very next frame goes back to paintFrame, which
        // resizes the canvas to the camera and draws it, so the picture is
        // already correct before anything below has run.
        compositing = false;
        if (screenVideo) {
          // Detached from the dead track, but the ELEMENT is kept. Creating
          // one costs a decode pipeline set-up, and a creator toggling a share
          // on and off between segments would pay it every time. Not cleared
          // to a blank source either — `srcObject = null` is enough to stop it
          // decoding, and paintComposite is no longer being called.
          screenVideo.pause();
          screenVideo.srcObject = null;
        }
        console.info('[composite] off — publishing the camera frame');
        return;
      }

      const [screenTrack] = next.getVideoTracks();
      if (!screenTrack) {
        console.warn('[composite] display stream has no video track; staying camera-only');
        return;
      }

      if (!screenVideo) {
        // Same three properties as the camera's element and for the same
        // reasons: never in the document, muted and playsInline so no
        // autoplay policy anywhere refuses to decode it.
        screenVideo = document.createElement('video');
        screenVideo.muted = true;
        screenVideo.playsInline = true;
      }
      screenVideo.srcObject = new MediaStream([screenTrack]);
      // Awaited, not fired and forgotten: a paused element decodes nothing, so
      // flipping `compositing` before this resolved would publish a frame with
      // an empty top slot. Caught, because Safari rejects play() for reasons
      // that do not stop it playing, and a rejected promise here must not cost
      // the creator their broadcast.
      await screenVideo.play().catch((err) => {
        console.warn('[composite] screen video play() rejected', err);
      });

      compositing = true;
      const settings = screenTrack.getSettings();
      const rects = layoutRects(currentLayout, currentPipCorner);
      console.info(
        `[composite] on — ${COMPOSITE_WIDTH}x${COMPOSITE_HEIGHT} ${currentLayout}: screen ` +
          `${settings.width ?? '?'}x${settings.height ?? '?'} contained in ` +
          `${rects.screen.width}x${rects.screen.height} at y=${rects.screen.y}, camera ` +
          (rects.face
            ? `covering ${rects.face.width}x${rects.face.height} at ` +
              `${rects.face.x},${rects.face.y}`
            : 'not drawn'),
      );
    },
    setSource: async (next) => {
      const [nextTrack] = next.getVideoTracks();
      if (!nextTrack) return;
      video.srcObject = new MediaStream([nextTrack]);
      // Safari pauses a video element when its srcObject is replaced, and a
      // paused element decodes no frames — so the canvas would hold the last
      // frame of the old camera forever.
      await video.play().catch(() => undefined);
    },
    stop: () => {
      running = false;
      cancelVideoFrame();
      // The worker holds an interval on a thread of its own: nothing about
      // this canvas going away stops it, and a creator who ends a broadcast
      // and starts another would accumulate one live worker per broadcast,
      // each still posting 30 messages a second at a handler whose canvas is
      // gone. Terminated here, with its blob URL, is the only place that
      // cannot be missed.
      stopTicker();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      // Only the canvas tracks: the source belongs to whoever opened the
      // camera, and stopping it here would take the preview with it. Both
      // streams, because on desktop they are two different canvases and a
      // publish track left running keeps painting into an encoder that has
      // gone.
      previewStream.getVideoTracks().forEach((track) => track.stop());
      publishStream.getVideoTracks().forEach((track) => track.stop());
      video.srcObject = null;
      // The screen share's element, detached for the same reason as the
      // camera's. The display TRACK is not stopped here — it belongs to
      // whoever opened it (see lib/live/screenShareCapture), and stopping it
      // from in here would take Chrome's "Stop sharing" bar down without the
      // studio ever knowing its own toggle had moved.
      compositing = false;
      if (screenVideo) {
        screenVideo.pause();
        screenVideo.srcObject = null;
        screenVideo = null;
      }
    },
  };
}
