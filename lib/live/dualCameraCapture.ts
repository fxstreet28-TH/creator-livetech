'use client';

/**
 * CAN THIS PHONE RUN TWO CAMERAS AT ONCE? Ask the device, never the user agent.
 *
 * A desktop creator composites a shared screen above their face (PRs #62-#65).
 * A phone creator cannot: `getDisplayMedia` does not exist in any browser on
 * iOS, so there is no screen to share. But the BROADCAST Por wants is the same
 * shape either way — something to look at on top, the person talking about it
 * below — and on a phone the thing to look at is not a screen, it is whatever
 * the BACK camera is pointed at: a trading terminal, a second monitor, a
 * printed chart. Two `getUserMedia` streams instead of one camera and one
 * display capture, into the same composite, in the same slots.
 *
 * ============================================================================
 * THE PROBLEM, AND IT IS THE WHOLE REASON THIS MODULE EXISTS.
 * ============================================================================
 *
 * MANY PHONES CANNOT OPEN BOTH CAMERAS AT THE SAME TIME, and the ones that can
 * do not all admit it the same way. iOS supports simultaneous capture only
 * through `AVCaptureMultiCamSession`, a native API; Safari's `getUserMedia` has
 * historically handed out one active camera at a time, and asking for a second
 * has been observed to do any of three things:
 *
 *   1. throw (NotReadableError, or OverconstrainedError),
 *   2. succeed and silently END the first camera's track, or
 *   3. succeed, leave the first track reporting `readyState === 'live'`, and
 *      quietly stop delivering frames from it.
 *
 * The third is the dangerous one. A track can be live and silent, so
 * `readyState` alone is not evidence — a studio that trusted it would publish
 * a stacked frame with a FROZEN half, which is worse than not offering the
 * feature: a creator cannot see their own broadcast, so the first person to
 * notice is a viewer.
 *
 * So this module does not ask whether the device is an iPhone, or what iOS
 * version it is running, or whether it is an iPhone 11 or newer (which is the
 * hardware line for multi-cam, and still tells you nothing about whether SAFARI
 * exposes it). It OPENS THE SECOND CAMERA AND LOOKS AT WHAT HAPPENED — to both
 * tracks, counting frames out of each, before a single composite frame is
 * published.
 *
 * ============================================================================
 * THE THREE TIERS, AND WHAT EACH ONE MEANS FOR THE STUDIO.
 * ============================================================================
 *
 *  - 'dual'        Both cameras are live and both are delivering frames. The
 *                  studio composites back-on-top / front-below. This is the
 *                  feature as asked for.
 *  - 'single'      The device would not do it: the second open threw, or it
 *                  took the first camera down with it. The studio must NOT
 *                  render two slots — see the note on recovery below — and
 *                  falls back to the one-camera broadcast with its existing
 *                  flip control.
 *  - 'unavailable' There is no second camera to open at all. A front-only
 *                  device, or a locked-down webview that enumerates one
 *                  videoinput. The control does not render, exactly as the
 *                  desktop share button does not render without
 *                  `getDisplayMedia`.
 *
 * ============================================================================
 * THE PROBE MUST NOT COST THE CREATOR THEIR BROADCAST. THIS IS THE HARD PART.
 * ============================================================================
 *
 * The camera being probed is not idle — it is the camera a LIVE broadcast is
 * currently drawing and publishing. Case 2 above means the act of asking the
 * question can END the source of a running broadcast. So `probeDualCamera`
 * owns its own recovery: where the primary camera did not survive, it stops
 * the second, RE-OPENS the primary, and hands the new stream back as
 * `recoveredPrimary` for the caller to point the pipeline at. A creator who
 * taps the dual-camera button on a phone that cannot do it must end up exactly
 * where they started — one camera, still live, still publishing — with a
 * message rather than a black frame.
 *
 * PROBE ON A TAP, NOT ON LOAD. Camera permission and device state are only
 * meaningful after a user gesture: before permission `enumerateDevices` hides
 * labels and may under-report, and opening a camera on page load to find out
 * what a button would do is a camera light nobody asked for. The one thing
 * read early is the DEVICE COUNT, which decides whether the button renders,
 * and that is read after the broadcast's own camera is already open — so the
 * permission is granted and the list is complete.
 *
 * THE ANSWER IS CACHED FOR THE SESSION, in one direction on purpose: a 'single'
 * or 'unavailable' verdict short-circuits every later tap, because re-probing
 * means re-running the open that just took a live camera down. A 'dual' verdict
 * is re-verified on each mount, which is cheap when it works — the whole check
 * finishes in the time it takes two cameras to deliver two frames.
 */

import { openCamera } from './cameraCapture';
import type { CameraFacing } from './livekitClient';
import type { BroadcastQuality } from './types';

/** What this device turned out to be able to do. See the header. */
export type DualCameraTier = 'dual' | 'single' | 'unavailable';

export interface DualCameraProbeResult {
  tier: DualCameraTier;
  /**
   * Tier 1 only: the SECOND camera, open, live, and proven to be delivering
   * frames. Handed over rather than closed and reopened by the caller — the
   * probe already paid for the open, and a second one is another chance for
   * the device to change its mind.
   */
  second: MediaStream | null;
  /** Which way `second` faces. The opposite of the primary. */
  secondFacing: CameraFacing | null;
  /**
   * Set ONLY when the primary camera did not survive the probe and had to be
   * reopened. The caller MUST point the pipeline at this before anything else
   * — the stream it was drawing is dead.
   *
   * Null in the happy path and null when the primary survived a failed probe,
   * which are the two common cases.
   */
  recoveredPrimary: MediaStream | null;
  /** How many videoinput devices `enumerateDevices` reported. */
  cameraCount: number;
  /** One line, diagnostic, English. Logged and shown in the dev bench. */
  detail: string;
}

/**
 * How long a camera gets to prove it is delivering frames.
 *
 * 1500ms is several dozen frames at 30fps, and generous on purpose: a camera
 * that has just been opened spends real time warming up, and a phone that is
 * mid-broadcast is a busy phone. The cost of being impatient is declaring a
 * working device broken; the cost of waiting is a second and a half on one tap.
 */
const FRAME_PROOF_TIMEOUT_MS = 1_500;

/**
 * How many frames count as proof. TWO, not one.
 *
 * One frame is not evidence of a live camera: a `<video>` attached to a track
 * that has already stalled can still present the last frame it decoded, and
 * `requestVideoFrameCallback` will report it. Two frames means the source
 * advanced while we were watching, which is the actual question.
 */
const FRAMES_REQUIRED = 2;

/** The other one. There are two, and the whole feature is about both. */
export function oppositeFacing(facing: CameraFacing): CameraFacing {
  return facing === 'user' ? 'environment' : 'user';
}

/**
 * The session's verdict, once it is known.
 *
 * Module scope rather than React state: it is a property of the DEVICE, it
 * cannot change while the page is open, and every studio and dev bench on the
 * page should get the same answer. Cleared only by a reload — or by
 * `resetDualCameraProbe`, which exists for the bench and for nothing else.
 */
let cachedTier: DualCameraTier | null = null;

export function cachedDualCameraTier(): DualCameraTier | null {
  return cachedTier;
}

/** For the dev bench, which needs to probe the same device more than once. */
export function resetDualCameraProbe(): void {
  cachedTier = null;
}

/**
 * How many cameras this device admits to having.
 *
 * The Tier 3 gate, and the ONLY thing read before the creator taps: a device
 * reporting fewer than two videoinputs has no second camera to composite, so
 * the control does not render at all rather than rendering and failing.
 *
 * Read AFTER the broadcast's camera is open, which matters: without a granted
 * permission, browsers return entries with empty labels and Safari has been
 * known to collapse them, so a count taken at page load is not the same count.
 */
export async function countVideoInputs(): Promise<number> {
  if (typeof navigator === 'undefined') return 0;
  if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return 0;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput').length;
  } catch (err) {
    // A permissions policy can refuse the whole call. Unknown is reported as
    // zero, which hides the button — the honest failure for a control whose
    // only job is to open a camera.
    console.warn('[dualcam] enumerateDevices failed', err);
    return 0;
  }
}

/**
 * Is this track actually producing pictures, right now?
 *
 * `readyState === 'live'` is checked first and is necessary, not sufficient —
 * see case 3 in the header. The real test is counting frames out of a detached
 * `<video>`, by `requestVideoFrameCallback` where it exists and by watching
 * `currentTime` advance where it does not (Firefox, and older WebKit).
 *
 * Both counters run and either can settle it. They are kept SEPARATE so that
 * one frame seen twice — once by each mechanism — cannot be mistaken for two
 * frames, which would be exactly the false pass this function exists to
 * prevent.
 *
 * Exported because it is the load-bearing claim of this module and the dev
 * bench asserts on it directly.
 */
export async function trackDeliversFrames(
  track: MediaStreamTrack | undefined,
  timeoutMs = FRAME_PROOF_TIMEOUT_MS,
): Promise<boolean> {
  if (!track || track.readyState !== 'live') return false;
  if (typeof document === 'undefined') return false;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);

  try {
    await video.play().catch(() => undefined);
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let framesByCallback = 0;
      let framesByClock = 0;
      let lastTime = -1;

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(deadline);
        window.clearInterval(poll);
        resolve(ok);
      };

      const deadline = window.setTimeout(() => finish(false), timeoutMs);

      const withCallback = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (typeof withCallback.requestVideoFrameCallback === 'function') {
        const onFrame = () => {
          if (settled) return;
          framesByCallback += 1;
          if (framesByCallback >= FRAMES_REQUIRED) finish(true);
          else withCallback.requestVideoFrameCallback?.(onFrame);
        };
        withCallback.requestVideoFrameCallback(onFrame);
      }

      // The fallback, and the watchdog: a track that ENDS mid-check is a
      // failure that no frame callback will ever report, because the callback
      // simply stops arriving.
      const poll = window.setInterval(() => {
        if (track.readyState !== 'live') {
          finish(false);
          return;
        }
        if (video.videoWidth > 0 && video.currentTime > lastTime) {
          lastTime = video.currentTime;
          framesByClock += 1;
          if (framesByClock >= FRAMES_REQUIRED) finish(true);
        }
      }, 80);
    });
  } finally {
    // The element is thrown away; the TRACK is not ours to stop — it belongs
    // to the broadcast, or to the probe's own caller.
    video.pause();
    video.srcObject = null;
  }
}

export interface DualCameraProbeOptions {
  /** The rung, passed through to openCamera. */
  quality: BroadcastQuality;
  /** Ask for an upright frame — true on the phone path this ships for. */
  portrait: boolean;
  /** The camera the broadcast is ALREADY drawing and publishing. */
  primary: MediaStream;
  /** Which way that camera faces. The probe opens the other one. */
  primaryFacing: CameraFacing;
}

/**
 * Open the second camera, and find out what the device did about it.
 *
 * The whole sequence, in the order it has to happen:
 *
 *   1. Count the cameras. Fewer than two and there is nothing to open.
 *   2. Open the OPPOSITE facing to the one already running. No audio — the
 *      broadcast's microphone is on the primary stream, and asking for a
 *      second one either fails or leaves two microphones open.
 *   3. Prove the SECOND delivers frames. A camera that opened and produces
 *      nothing is not a camera.
 *   4. Prove the PRIMARY still delivers frames. This is the check the whole
 *      module is built around: the first camera is the one the device may have
 *      taken away, silently, to give us the second.
 *   5. If either proof fails, put the phone back the way it was — stop the
 *      second, reopen the primary if it died — and report 'single'.
 *
 * Never throws for a device that simply cannot do this: a refusal is a tier,
 * not an error. It throws only where recovery itself failed, which is a
 * broadcast that needs the studio's error path rather than a message.
 */
export async function probeDualCamera(
  options: DualCameraProbeOptions,
): Promise<DualCameraProbeResult> {
  const { quality, portrait, primary, primaryFacing } = options;
  const secondFacing = oppositeFacing(primaryFacing);
  const cameraCount = await countVideoInputs();

  const refuse = (tier: DualCameraTier, detail: string): DualCameraProbeResult => {
    cachedTier = tier;
    console.info(`[dualcam] tier=${tier} cameras=${cameraCount} — ${detail}`);
    return { tier, second: null, secondFacing: null, recoveredPrimary: null, cameraCount, detail };
  };

  if (cachedTier === 'single' || cachedTier === 'unavailable') {
    // Asked and answered. Re-running the open is how a creator takes their own
    // camera down twice — see the caching note in the header.
    return refuse(cachedTier, 'cached from an earlier probe on this device');
  }

  if (cameraCount < 2) {
    return refuse(
      'unavailable',
      cameraCount === 0
        ? 'no videoinput devices reported'
        : 'only one videoinput device — nothing to composite with',
    );
  }

  const [primaryTrack] = primary.getVideoTracks();
  if (!primaryTrack) {
    return refuse('single', 'the broadcast has no video track to keep');
  }

  let second: MediaStream | null = null;
  try {
    second = (
      await openCamera({ quality, portrait, facingMode: secondFacing, audio: false })
    ).stream;
  } catch (err) {
    const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // The device said no outright — the cleanest of the three failures, and
    // the one where the primary is certainly untouched.
    return refuse('single', `second camera (${secondFacing}) refused: ${name}`);
  }

  const [secondTrack] = second.getVideoTracks();

  /*
    BOTH PROOFS, IN PARALLEL AND ON THE SAME WALL CLOCK.

    Sequentially would take twice as long for no more certainty, and worse: a
    primary checked AFTER the second had already been watched for a second and
    a half is a primary given extra time to fail quietly, which reports a
    device as working that was already halfway to not.
  */
  const [secondLive, primaryLive] = await Promise.all([
    trackDeliversFrames(secondTrack),
    trackDeliversFrames(primaryTrack),
  ]);

  if (secondLive && primaryLive) {
    cachedTier = 'dual';
    const s = secondTrack?.getSettings() ?? {};
    const p = primaryTrack.getSettings() ?? {};
    const detail =
      `both live — ${secondFacing} ${s.width ?? '?'}x${s.height ?? '?'}, ` +
      `${primaryFacing} ${p.width ?? '?'}x${p.height ?? '?'}`;
    console.info(`[dualcam] tier=dual cameras=${cameraCount} — ${detail}`);
    return { tier: 'dual', second, secondFacing, recoveredPrimary: null, cameraCount, detail };
  }

  /*
    IT DID NOT WORK. PUT THE PHONE BACK.

    The second camera goes first and unconditionally: whatever state the device
    is in, the one thing that is certainly not wanted is a camera nobody is
    drawing holding a sensor the primary may be waiting for.
  */
  second.getTracks().forEach((track) => track.stop());
  second = null;

  const why = !secondLive
    ? `second camera (${secondFacing}) opened but delivered no frames`
    : `opening the second camera (${secondFacing}) stopped the ${primaryFacing} camera`;

  if (primaryLive) {
    // The common, benign failure: the device would not give us a second
    // camera, and the broadcast never noticed. Nothing to recover.
    return refuse('single', why);
  }

  /*
    THE PRIMARY IS GONE, and the broadcast is currently publishing a canvas
    drawing a dead track. Reopening it is not optional and it is not the
    caller's job to remember — a studio that had to know this could happen is a
    studio that will one day forget.
  */
  console.warn(`[dualcam] ${why} — reopening the ${primaryFacing} camera`);
  primary.getVideoTracks().forEach((track) => track.stop());

  let recoveredPrimary: MediaStream;
  try {
    recoveredPrimary = (
      await openCamera({ quality, portrait, facingMode: primaryFacing, audio: false })
    ).stream;
  } catch (err) {
    // Recovery failed, which is the one outcome this module cannot paper over:
    // the broadcast has no camera. Thrown so the studio's error path runs
    // rather than the studio quietly showing a frozen frame.
    cachedTier = 'single';
    console.error('[dualcam] could not reopen the primary camera', err);
    throw err;
  }

  cachedTier = 'single';
  const detail = `${why}; ${primaryFacing} camera reopened`;
  console.info(`[dualcam] tier=single cameras=${cameraCount} — ${detail}`);
  return { tier: 'single', second: null, secondFacing: null, recoveredPrimary, cameraCount, detail };
}
