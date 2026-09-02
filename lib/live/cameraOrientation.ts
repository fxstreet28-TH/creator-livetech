/**
 * Which way round the camera picture faces — for the creator, and for viewers.
 *
 * Two independent switches, because they answer two different questions:
 *
 *  - MIRROR MY PREVIEW is about the creator's own screen. It changes nothing
 *    that leaves the machine.
 *  - FLIP FOR VIEWERS is about the published frames. It is applied inside the
 *    filter canvas (see createFilteredStream in ./cameraFilters), so the flip
 *    reaches the encoder, the egress, Bunny and every viewer — the same route
 *    the look takes, through the same canvas. There is no second canvas.
 *
 * Keeping them independent is the whole point, and it is why
 * `shouldFlipPreview` exists: on the broadcast screen the creator's self-view
 * IS the canvas, so turning the output flip on would otherwise swing their
 * preview around with it. The preview transform is derived from BOTH switches
 * so that it does not.
 *
 * WHAT "MIRROR" MEANS HERE
 *
 * The raw camera image puts a raised right hand on the LEFT of the frame —
 * the mirror-like view every video app opens with, and what /creator/live has
 * always shown. That is this module's `mirrorPreview: true`, the default, so
 * turning the switch ON changes nothing about what a creator is used to.
 * Turning it OFF is the new behaviour the brief asks for: raise your right
 * hand, see it on the right, and point at the chart you actually mean.
 */

const MIRROR_PREVIEW_KEY = 'aurum:camera:mirror_preview';
const FLIP_OUTPUT_KEY = 'aurum:camera:flip_output';

export interface CameraOrientation {
  /** Creator's own preview only. ON = the familiar mirror-like view. */
  mirrorPreview: boolean;
  /** Published frames only. ON = viewers get a horizontally flipped picture. */
  flipOutput: boolean;
}

export const DEFAULT_CAMERA_ORIENTATION: CameraOrientation = {
  mirrorPreview: true,
  flipOutput: false,
};

/**
 * Should the <video> element showing the creator their own picture be flipped
 * in CSS?
 *
 * `sourceFlipped` says whether the frames reaching that element have ALREADY
 * been flipped by the canvas — true on the broadcast screen when the output
 * flip is on, false on the setup screen, which renders the raw camera. The
 * answer is the same expression either way: flip in CSS exactly when the two
 * agree, which lands the creator on the view they asked for and leaves the
 * other switch's effect invisible to them.
 *
 *   mirror ON,  source raw     -> false  (raw already looks mirrored)
 *   mirror ON,  source flipped -> true   (undo the output flip for the creator)
 *   mirror OFF, source raw     -> true   (raise right, see right)
 *   mirror OFF, source flipped -> false  (the canvas already did it)
 */
export function shouldFlipPreview(mirrorPreview: boolean, sourceFlipped: boolean): boolean {
  return mirrorPreview === sourceFlipped;
}

/** True while both switches sit at their defaults — what the badge asks. */
export function isDefaultOrientation(orientation: CameraOrientation): boolean {
  return (
    orientation.mirrorPreview === DEFAULT_CAMERA_ORIENTATION.mirrorPreview &&
    orientation.flipOutput === DEFAULT_CAMERA_ORIENTATION.flipOutput
  );
}

/**
 * localStorage directly, rather than through getAuthStorage().
 *
 * That adapter is async on native (Capacitor Preferences), and these two
 * booleans decide a CSS transform on the first frame the creator sees — an
 * awaited read would show them the wrong way round and then swing the picture
 * once it resolved. This is a display preference, not a credential; a WebView
 * that loses it falls back to the defaults, which is the behaviour every
 * creator had before this existed.
 *
 * Every access is wrapped: Safari in private mode throws on localStorage
 * rather than returning null, and a broadcast must not fail to open because a
 * preference could not be read.
 */
function readBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBoolean(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false');
  } catch {
    // Quota, private mode, a WebView with storage disabled — the switch still
    // works for this session, it just will not be remembered.
  }
}

/**
 * THE STORE
 *
 * A module-level cache with subscribers, rather than component state seeded
 * from storage in an effect. The shape is what useSyncExternalStore wants (see
 * lib/hooks/useCameraOrientation), and it buys two things:
 *
 *  - No setState inside an effect on mount, so no cascading render.
 *  - No hydration mismatch. Next renders this client page on the server, where
 *    there is no storage and the answer is always the defaults;
 *    getServerSnapshot below returns exactly that, and React swaps in the
 *    stored value after hydration instead of tripping over the difference.
 *
 * `cached` must keep the SAME object identity between reads or
 * useSyncExternalStore will loop, which is why it is replaced only in
 * setCameraOrientation.
 */
let cached: CameraOrientation | null = null;
const listeners = new Set<() => void>();

/** The current value, read from storage once and remembered after that. */
export function getCameraOrientation(): CameraOrientation {
  if (!cached) {
    cached = {
      mirrorPreview: readBoolean(MIRROR_PREVIEW_KEY, DEFAULT_CAMERA_ORIENTATION.mirrorPreview),
      flipOutput: readBoolean(FLIP_OUTPUT_KEY, DEFAULT_CAMERA_ORIENTATION.flipOutput),
    };
  }
  return cached;
}

/** What the server and the hydration pass see: the defaults, always. */
export function getServerCameraOrientation(): CameraOrientation {
  return DEFAULT_CAMERA_ORIENTATION;
}

export function setCameraOrientation(next: CameraOrientation): void {
  cached = next;
  writeBoolean(MIRROR_PREVIEW_KEY, next.mirrorPreview);
  writeBoolean(FLIP_OUTPUT_KEY, next.flipOutput);
  for (const listener of listeners) listener();
}

export function subscribeCameraOrientation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
