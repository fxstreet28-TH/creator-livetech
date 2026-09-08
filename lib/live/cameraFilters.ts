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
 * `stream` is what gets published. Its video track comes from a canvas that
 * this module redraws once per camera frame with `ctx.filter` set; its audio
 * tracks are the SOURCE's, passed through untouched — canvas.captureStream()
 * produces video only, and forgetting to carry the audio across is the classic
 * way to ship a silent broadcast.
 *
 * `setFilter` swaps the look mid-broadcast with no republish: the track is the
 * canvas, and the canvas does not care what is being drawn onto it. That is
 * the whole reason the look is changeable from the broadcast bottom bar.
 *
 * COST: one draw per camera frame for the length of the broadcast. That is
 * real, and it is why /creator/live tells creators to broadcast from a
 * computer. `requestVideoFrameCallback` is used where available so the loop
 * runs at the CAMERA's rate (30fps) rather than the display's — on a 120Hz
 * screen a requestAnimationFrame loop would do four times the work for the
 * same output.
 */
export interface FilteredStream {
  /** Publish this. Video from the canvas, audio from the source. */
  stream: MediaStream;
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
  getStats: () => { fps: number; lookMode: LookMode };
  /** Stops the draw loop and the canvas track. Does NOT stop the source. */
  stop: () => void;
}

/**
 * THE PUBLISHED SHAPE IS 9:16 — the shape every viewer renders.
 *
 * A phone hands back an upright frame and there is nothing to do; that is the
 * pass-through below, and it is why the phone path (which asks for nothing —
 * see lib/live/cameraCapture.ts) is untouched by any of this.
 *
 * A WEBCAM hands back 16:9, and a 16:9 track rendered by a 9:16 player is
 * cover-cropped to a narrow column through the middle of the picture — which
 * is where the creator is NOT, because they sit where the camera is pointed
 * rather than where a crop they cannot see will land. That is the bug: a
 * desktop broadcast looked fine to the creator and arrived on a phone with
 * their face off the side.
 *
 * So the crop happens HERE, one step before the encoder, rather than in the
 * viewer. Two things follow, and both are the point:
 *
 *  - The creator's self-view IS this canvas, so they see the 9:16 and frame
 *    themselves inside it. That is the entire user interface of this feature —
 *    no drag, no zoom control, no safe-zone overlay.
 *  - The encoder never sees the two thirds of a webcam frame that no viewer
 *    was ever going to be shown. A 1280x720 webcam publishes 406x720: about a
 *    third of the pixels, off the uplink and out of the encoder's work.
 *
 * Decided by what the SOURCE gave, never by the device or the viewport. A
 * landscape phone crops (correct — its viewers are still upright); a portrait
 * webcam, a rotated tablet or a square sensor passes straight through.
 *
 * The crop is published at its OWN resolution and never upscaled to some
 * nominal 720x1280: LiveKit's simulcast makes its rungs from whatever it is
 * given, MediaMTX passes frames through, and an upscale would buy a bigger
 * number at the cost of encoder work and sharpness.
 */
export const PUBLISH_ASPECT = 9 / 16;

/** A rectangle of the SOURCE, in source pixels. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Whether this source gets cropped — i.e. whether it is wider than it is tall.
 *
 * The whole branch, in one place, because it is the one decision anything
 * outside this file might want to reason about. Callers that need the numbers
 * ask portraitCropRect instead: the previews shape themselves from the RECT so
 * that the box a creator frames themselves in cannot drift away from the frame
 * being published.
 */
export function cropsToPortrait(sourceWidth: number, sourceHeight: number): boolean {
  return sourceWidth > 0 && sourceHeight > 0 && sourceWidth > sourceHeight;
}

/**
 * The part of the source that gets published.
 *
 * A centred 9:16 column of a landscape source; the whole frame of anything
 * else. The full HEIGHT is always kept: cropping the top off a webcam is how
 * you cut a creator's head off, and keeping it makes the column as wide as the
 * source can afford.
 */
export function portraitCropRect(sourceWidth: number, sourceHeight: number): CropRect {
  if (!cropsToPortrait(sourceWidth, sourceHeight)) {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }
  const width = Math.round(sourceHeight * PUBLISH_ASPECT);
  return { x: Math.round((sourceWidth - width) / 2), y: 0, width, height: sourceHeight };
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

  /*
    The published rectangle of the source. Primed from the track's own account
    of itself so the captured track STARTS at the published shape rather than
    changing size a frame later, and corrected from the decoded frame's real
    dimensions in the draw loop below.
  */
  let sourceWidth = 0;
  let sourceHeight = 0;
  let crop = portraitCropRect(width, height);

  const canvas = document.createElement('canvas');
  canvas.width = crop.width;
  canvas.height = crop.height;
  // `alpha: false` — the camera has no transparency, and telling the browser
  // so lets it skip compositing work on every single frame.
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D is unavailable');

  let currentFilter = initialFilter;
  let currentFlipped = initialFlipped;
  let currentZoom = 1;
  let running = true;
  let rafId: number | null = null;
  let frameCallbackId: number | null = null;

  /*
    WHICH LOOK IMPLEMENTATION THIS STREAM USES, decided ONCE.

    Not per frame, and not per look change: the answer is a property of the
    browser, it cannot change while the page is open, and re-deciding it inside
    the draw loop would put a branch and a property read on the hot path for a
    constant.

    Desktop lands on 'filter' and is bit-for-bit unchanged by any of this.
  */
  const lookMode: LookMode = supportsCanvasFilter() ? 'filter' : 'composite';
  let vignette: VignetteCache | null = null;

  // The measured draw rate — see getStats. A counter and a window, because a
  // per-frame delta reads as noise on a phone and what anyone actually wants
  // to know is whether this is holding 30 or dropping to 12.
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let framesThisWindow = 0;
  let windowStartedAt = now();
  let measuredFps = 0;

  console.info(`[camera] look mode: ${lookMode}`);

  const draw = () => {
    if (!running) return;

    /*
      THE CANVAS IS THE SIZE OF THE PUBLISHED CROP, AND IT IS CHECKED EVERY
      FRAME.

      The crop is the camera's whole frame on a phone (see portraitCropRect),
      so everything this comment says about following the camera still holds
      there — the geometry below just goes through the crop rather than
      straight to the video element.

      Following the DECODED frame rather than getSettings() is what makes a
      phone publish PORTRAIT. `getSettings()` above is
      read once, before the track has necessarily settled, and on iOS Safari
      it is frequently the landscape figure that was ASKED for rather than the
      portrait one the camera actually produces. A canvas fixed at that first
      answer then gets `drawImage(video, 0, 0, 1280, 720)` — which does not
      letterbox, it STRETCHES — so a 720x1280 portrait camera was being
      squashed into a landscape frame and published that way.

      `videoWidth`/`videoHeight` are the decoded frame's real dimensions, so
      following them fixes that and three other things for free: a camera that
      settles a moment after `play()`, a phone rotated mid-broadcast, and the
      front/back flip in setSource handing over a different aspect ratio.

      Writing to canvas.width resets the whole 2D context, so it is guarded on
      an actual change — doing it every frame would clear the filter and the
      transform below on every frame.
    */
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      /*
        THE CROP, recomputed only when the source dimensions actually change —
        a camera settling after play(), a front/back flip, a phone rotated
        mid-broadcast, a track re-negotiated to a different rung. Per frame it
        would be arithmetic nobody needs; the geometry is a property of the
        source, not of the frame.
      */
      if (video.videoWidth !== sourceWidth || video.videoHeight !== sourceHeight) {
        sourceWidth = video.videoWidth;
        sourceHeight = video.videoHeight;
        crop = portraitCropRect(sourceWidth, sourceHeight);
        // One line, once per change, in the same shape as the [camera] report
        // in cameraCapture: this is the line that says whether a broadcast is
        // publishing the portrait crop or passing a phone's frame through.
        console.info(
          `[camera] publish geometry: source ${sourceWidth}x${sourceHeight} -> ` +
            `crop ${crop.width}x${crop.height} at ${crop.x},${crop.y} ` +
            `(${cropsToPortrait(sourceWidth, sourceHeight) ? '9:16 centre crop' : 'pass-through'})`,
        );
      }

      // The PUBLISHED ratio — the crop's, not the camera's — capped in SIZE
      // only where the caller asked for a cap. Rounded to even numbers because
      // some encoders reject odd ones. Never upscaled: a 1280x720 webcam
      // publishes 406x720 and LiveKit makes its simulcast rungs from that.
      const longest = Math.max(crop.width, crop.height);
      const scale = maxLongEdge && longest > maxLongEdge ? maxLongEdge / longest : 1;
      const nextWidth = Math.round((crop.width * scale) / 2) * 2;
      const nextHeight = Math.round((crop.height * scale) / 2) * 2;
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
        // The vignette gradient is built for one canvas size. applyLookPasses
        // checks this too; dropping it here means the check never has to fail.
        vignette = null;
      }
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
    /*
      The source rectangle, in SOURCE pixels — which are no longer the same as
      the canvas's once a cap is downscaling the frame.

      At zoom 1 this is the whole PUBLISHED rectangle drawn across the whole
      canvas: the 9:16 column of a landscape camera, or the entire frame of an
      upright one. Above 1 it is a centred sub-rect OF THAT — zoom stays a zoom
      into what is being published rather than a second, competing crop — and
      the output resolution never changes with it.
    */
    const zoom = currentZoom > 1 ? currentZoom : 1;
    const sw = crop.width / zoom;
    const sh = crop.height / zoom;
    const sx = crop.x + (crop.width - sw) / 2;
    const sy = crop.y + (crop.height - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
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
    */
    if (lookMode === 'composite') {
      vignette = applyLookPasses(ctx, currentFilter, vignette);
    }

    framesThisWindow += 1;
    const at = now();
    if (at - windowStartedAt >= 1000) {
      measuredFps = Math.round((framesThisWindow * 1000) / (at - windowStartedAt));
      framesThisWindow = 0;
      windowStartedAt = at;
    }

    schedule();
  };

  const schedule = () => {
    if (!running) return;
    const withFrameCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    if (typeof withFrameCallback.requestVideoFrameCallback === 'function') {
      frameCallbackId = withFrameCallback.requestVideoFrameCallback(draw);
      return;
    }
    rafId = requestAnimationFrame(draw);
  };

  draw();

  const stream = canvas.captureStream(frameRate);
  // Audio is not optional here — see the note above.
  for (const audioTrack of source.getAudioTracks()) stream.addTrack(audioTrack);

  return {
    stream,
    setFilter: (id) => {
      currentFilter = id;
    },
    setFlipped: (flipped) => {
      currentFlipped = flipped;
    },
    getStats: () => ({ fps: measuredFps, lookMode }),
    setZoom: (zoom) => {
      // Floored at 1: there is no such thing as digital zoom OUT. Widening the
      // field of view needs a different camera, which is the 0.5x ultra-wide
      // device switch and not this.
      currentZoom = Number.isFinite(zoom) && zoom > 1 ? zoom : 1;
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
      if (rafId !== null) cancelAnimationFrame(rafId);
      const withFrameCallback = video as HTMLVideoElement & {
        cancelVideoFrameCallback?: (id: number) => void;
      };
      if (frameCallbackId !== null && withFrameCallback.cancelVideoFrameCallback) {
        withFrameCallback.cancelVideoFrameCallback(frameCallbackId);
      }
      // Only the canvas track: the source belongs to whoever opened the
      // camera, and stopping it here would take the preview with it.
      stream.getVideoTracks().forEach((track) => track.stop());
      video.srcObject = null;
    },
  };
}
