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
 *    `filter` style. The compositor does all of it and it costs nothing.
 *  - The BROADCAST draws each camera frame onto a canvas with the same string
 *    as `ctx.filter`, and publishes THAT canvas as the video track. See
 *    createFilteredStream below.
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

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
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

  const draw = () => {
    if (!running) return;

    /*
      THE CANVAS IS THE SIZE OF THE CAMERA, ALWAYS, AND IT IS CHECKED EVERY
      FRAME.

      This is what makes a phone publish PORTRAIT. `getSettings()` above is
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
      // The camera's own ratio, capped in SIZE only where the caller asked for
      // a cap. Rounded to even numbers because some encoders reject odd ones.
      const longest = Math.max(video.videoWidth, video.videoHeight);
      const scale = maxLongEdge && longest > maxLongEdge ? maxLongEdge / longest : 1;
      const nextWidth = Math.round((video.videoWidth * scale) / 2) * 2;
      const nextHeight = Math.round((video.videoHeight * scale) / 2) * 2;
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
    }

    // save/restore around the whole paint: both the filter and the transform
    // are drawing state, and a flip that leaked into the next frame would
    // flip it back. Set per frame rather than once, so a look or a flip
    // changed mid-broadcast takes effect on the very next frame.
    ctx.save();
    ctx.filter = filterCssFor(currentFilter);
    if (currentFlipped) {
      // Move the origin to the right edge, then draw leftwards. Scaling
      // without the translate would put the picture off-canvas.
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    /*
      The source rectangle, in SOURCE pixels — which are no longer the same as
      the canvas's once a cap is downscaling the frame.

      At zoom 1 this is the whole camera frame drawn across the whole canvas:
      the full field of view, scaled but never cropped. Above 1 it is a centred
      sub-rect of the source, scaled up to fill the same canvas, so the output
      resolution never changes with zoom.
    */
    const zoom = currentZoom > 1 ? currentZoom : 1;
    const sw = video.videoWidth / zoom;
    const sh = video.videoHeight / zoom;
    const sx = (video.videoWidth - sw) / 2;
    const sy = (video.videoHeight - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    ctx.restore();
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
