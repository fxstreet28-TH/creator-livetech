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
   * Mirror the published frames horizontally, or stop mirroring them.
   *
   * Same deal as setFilter: one variable read by the draw loop, no republish.
   * The flip happens HERE, in the same canvas that applies the look, rather
   * than in a second canvas chained after it — one draw per frame is already
   * the expensive part of this pipeline and doubling it to turn a picture
   * around would be absurd.
   */
  setFlipped: (flipped: boolean) => void;
  /** Stops the draw loop and the canvas track. Does NOT stop the source. */
  stop: () => void;
}

export async function createFilteredStream(
  source: MediaStream,
  initialFilter: FilterId,
  frameRate = 30,
  initialFlipped = false,
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
  let running = true;
  let rafId: number | null = null;
  let frameCallbackId: number | null = null;

  const draw = () => {
    if (!running) return;
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
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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
