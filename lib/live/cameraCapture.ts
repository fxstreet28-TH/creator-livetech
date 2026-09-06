'use client';

/**
 * Opening a camera, and reporting what it gave.
 *
 * THE PHONE RULE, AND IT IS THE WHOLE FIX: ASK FOR NOTHING.
 *
 * An iPhone sensor is 4:3. iOS Safari satisfies a 9:16 or 16:9 `aspectRatio`,
 * and a width/height pair implying one, by CROPPING that sensor rather than by
 * letterboxing it — and it crops at native pixel density rather than
 * downscaling. So every size hint we sent was read as "give me the middle of
 * the picture", and the creator got a ~2x telephoto view of themselves while
 * the native camera app, which asks for nothing, showed the full frame.
 *
 * Two rounds of escalating ladders made this worse rather than better: each
 * rung was another way of describing a crop. The fix is to stop describing.
 * On a phone the request is `{ facingMode, frameRate }` and nothing else, one
 * call, no re-request — which returns the sensor's own field of view at its own
 * ratio, which is what the native app shows.
 *
 * The consequences are handled downstream rather than fought here:
 *
 *  - THE RATIO is the camera's, usually 3:4 upright. It is published as-is.
 *    The phone layouts cover-crop it for display and the desktop viewer
 *    pillarboxes it; nothing re-crops the TRACK.
 *  - THE SIZE may be larger than the broadcast needs (a 4032x3024 sensor mode
 *    is not something to encode). The filter canvas downscales the whole frame
 *    — see maxLongEdge in createFilteredStream. Never applyConstraints after
 *    the fact: iOS may satisfy that by cropping again, which is the bug.
 *
 * DESKTOP IS UNCHANGED and still asks for its quality rung: a webcam has no
 * sensor crop to fall into, the framed player wants a known ratio, and that
 * path is approved.
 *
 * Zoom is a separate, explicit control. 1x is the full field of view — never an
 * implicit crop.
 */

import type { BroadcastQuality } from './types';
import { resolutionFor, type CameraFacing } from './livekitClient';

/** One getUserMedia call and what came back. */
export interface CameraAttempt {
  /** 'phone-native' or 'desktop' — which constraint set was used. */
  label: string;
  constraints: MediaTrackConstraints;
  /** The track's own account of itself. Null when the call threw. */
  settings: MediaTrackSettings | null;
  /** Thai-free; this is diagnostic, not user-facing. */
  error: string | null;
}

export interface CameraOpenResult {
  stream: MediaStream;
  /** What the video track reports after settling. */
  settings: MediaTrackSettings;
  /**
   * What the track says it COULD do. The comparison that exposes a sensor
   * crop — see the header — and the source of the hardware zoom range.
   */
  capabilities: MediaTrackCapabilities | null;
  /** Derived from the settings, never from what was asked for. */
  orientation: 'portrait' | 'landscape' | 'square';
  /**
   * True when a portrait capture was asked for and the camera would not give
   * one. The caller must then publish LANDSCAPE rather than cover-cropping.
   */
  portraitRefused: boolean;
  /**
   * The one call that was made. An array because a failure records itself
   * here too, and because the shape survived the ladder this used to be.
   */
  attempts: CameraAttempt[];
}

export interface OpenCameraOptions {
  quality: BroadcastQuality;
  /** Ask for an upright frame. A phone; never a desktop. */
  portrait?: boolean;
  /** Names one specific camera. Mutually exclusive with facingMode. */
  deviceId?: string | null;
  facingMode?: CameraFacing | null;
  /** Whether to open a microphone too. False for a camera swap mid-broadcast. */
  audio?: boolean;
}

/**
 * The frame rate a phone asks for. The ONLY thing constrained on that path —
 * see the header. 30 is what every quality rung already used.
 */
const PHONE_FRAME_RATE = 30;

function orientationOf(settings: MediaTrackSettings): CameraOpenResult['orientation'] {
  const w = settings.width ?? 0;
  const h = settings.height ?? 0;
  if (w === 0 || h === 0) return 'landscape';
  if (w === h) return 'square';
  return w > h ? 'landscape' : 'portrait';
}

function identity(options: OpenCameraOptions): MediaTrackConstraints {
  // deviceId and facingMode are mutually exclusive on purpose: a device id
  // names one specific camera, and adding a facing hint is either redundant or
  // contradictory. Desktops pick by id (there is a picker); phones pick by
  // facing (there is a flip button).
  if (options.deviceId) return { deviceId: { exact: options.deviceId } };
  if (options.facingMode) return { facingMode: { ideal: options.facingMode } };
  return {};
}

/**
 * The constraints for one open. ONE set — there is no ladder any more.
 *
 * NO `exact` anywhere on either path: an exact constraint a camera cannot meet
 * is an OverconstrainedError, and a broadcast that refuses to start is worse
 * than one framed imperfectly.
 */
function constraintsFor(options: OpenCameraOptions): {
  label: string;
  constraints: MediaTrackConstraints;
} {
  if (options.portrait) {
    // THE PHONE. No width, no height, no aspectRatio — see the header. Every
    // one of those is read by iOS as permission to crop the sensor.
    return {
      label: 'phone-native',
      constraints: { ...identity(options), frameRate: { ideal: PHONE_FRAME_RATE } },
    };
  }

  // Desktop, unchanged and approved: the quality rung, in landscape.
  const { width, height, frameRate } = resolutionFor(options.quality);
  return {
    label: 'desktop',
    constraints: {
      ...identity(options),
      width: { ideal: Math.max(width, height) },
      height: { ideal: Math.min(width, height) },
      frameRate: { ideal: frameRate },
    },
  };
}

/**
 * Open the camera. ONE call — no escalation, no re-request.
 *
 * Throws when it fails, which the caller turns into the Thai media error. What
 * came back is reported rather than judged: `orientation` says which way up the
 * frame is, and the caller fits its preview to that instead of assuming.
 */
export async function openCamera(options: OpenCameraOptions): Promise<CameraOpenResult> {
  const { label, constraints } = constraintsFor(options);
  const attempts: CameraAttempt[] = [];

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: constraints,
      audio: options.audio !== false,
    });
  } catch (err) {
    attempts.push({
      label,
      constraints,
      settings: null,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    logReport(`${label}-failed`, attempts, {}, undefined);
    throw err;
  }

  const [track] = stream.getVideoTracks();
  const settings = track?.getSettings() ?? {};
  attempts.push({ label, constraints, settings, error: null });
  logReport(label, attempts, settings, track);

  const orientation = orientationOf(settings);
  return {
    stream,
    settings,
    capabilities: readCapabilities(track),
    orientation,
    // A phone asked for nothing and still handed back a landscape frame. It
    // should not happen now that no ratio is being requested, and the caller
    // letterboxes rather than cover-cropping if it does — a 16:9 track squeezed
    // into a 9:16 box is the zoom this whole change exists to remove.
    portraitRefused: options.portrait === true && orientation === 'landscape',
    attempts,
  };
}

function readCapabilities(track: MediaStreamTrack | undefined): MediaTrackCapabilities | null {
  if (!track || typeof track.getCapabilities !== 'function') return null;
  try {
    return track.getCapabilities();
  } catch {
    // Firefox has not implemented it; Safari added it late. Absent is fine —
    // it only powers the diagnostic and the hardware-zoom range.
    return null;
  }
}

/**
 * The whole story, in the console, once per open.
 *
 * Logged unconditionally rather than behind a debug flag: this is the data
 * that turns "it looks zoomed" into a decision, it is a handful of lines per
 * broadcast, and it contains nothing private — a resolution and a frame rate.
 */
function logReport(
  outcome: string,
  attempts: CameraAttempt[],
  settings: MediaTrackSettings,
  track: MediaStreamTrack | undefined,
) {
  const capabilities = readCapabilities(track) as
    | (MediaTrackCapabilities & { width?: { max?: number }; height?: { max?: number } })
    | null;
  const asked = attempts
    .map((a) => `${a.label}=${a.settings ? `${a.settings.width}x${a.settings.height}` : a.error}`)
    .join(' -> ');

  // One flat string, not format specifiers: this is read over a USB cable in
  // Safari's remote inspector on the phone that has the problem, and a line
  // that renders as "%s %d" there is a line nobody can use.
  console.info(
    `[camera] ${outcome}: ${settings.width ?? 0}x${settings.height ?? 0} ` +
      `ar=${aspectLabel(settings)} fps=${settings.frameRate ?? '?'} ` +
      `camMax=${capabilities?.width?.max ?? '?'}x${capabilities?.height?.max ?? '?'} ` +
      `| asked: ${asked}`,
  );
  // The full capability object separately, where it can be expanded rather
  // than truncated into the line above.
  console.info('[camera] capabilities', capabilities);
}

function aspectLabel(settings: MediaTrackSettings): string {
  const w = settings.width ?? 0;
  const h = settings.height ?? 0;
  if (!w || !h) return '?';
  return (w / h).toFixed(3);
}

/**
 * A one-line summary for the debug chip.
 *
 * Deliberately terse and deliberately numeric — "720x1280 9:16" is checkable
 * against the native camera app on the same phone; "portrait ✓" is not.
 */
export function describeCamera(result: CameraOpenResult | null): string {
  if (!result) return 'camera: —';
  const w = result.settings.width ?? 0;
  const h = result.settings.height ?? 0;
  const caps = result.capabilities as (MediaTrackCapabilities & { width?: { max?: number } }) | null;
  const maxW = caps?.width?.max;
  // The crop tell: a track much smaller than the camera's own maximum.
  const cropHint = maxW && maxW > Math.max(w, h) * 1.25 ? ` (cam max ${maxW})` : '';
  return `${w}x${h} ar${aspectLabel(result.settings)} ${result.orientation}${
    result.portraitRefused ? ' PORTRAIT-REFUSED' : ''
  }${cropHint}`;
}

/**
 * The camera's own zoom range, when it has one.
 *
 * Android Chrome has exposed this for years; iOS Safari from 17. Absent means
 * the digital fallback in the filter canvas is the only option — which is why
 * the caller asks this rather than assuming either way.
 */
export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

export function hardwareZoomRange(track: MediaStreamTrack | undefined): ZoomRange | null {
  if (!track || typeof track.getCapabilities !== 'function') return null;
  try {
    const caps = track.getCapabilities() as MediaTrackCapabilities & {
      zoom?: { min?: number; max?: number; step?: number };
    };
    const zoom = caps.zoom;
    if (!zoom || typeof zoom.min !== 'number' || typeof zoom.max !== 'number') return null;
    if (zoom.max <= zoom.min) return null;
    return { min: zoom.min, max: zoom.max, step: zoom.step ?? 0.1 };
  } catch {
    return null;
  }
}

/**
 * Ask the camera to zoom. Returns false when it would not, so the caller can
 * fall back to cropping in the canvas.
 *
 * `advanced` rather than a plain constraint: a plain one that cannot be met
 * rejects the whole applyConstraints call, and zoom is exactly the property a
 * device is most likely to clamp.
 */
export async function applyZoomConstraint(
  track: MediaStreamTrack | undefined,
  zoom: number,
  range: ZoomRange,
): Promise<boolean> {
  if (!track) return false;
  const clamped = Math.min(range.max, Math.max(range.min, zoom));
  try {
    // `zoom` is a real MediaTrackConstraintSet member in the Media Capture
    // Image spec, but not in lib.dom's MediaTrackConstraintSet, so the cast is
    // the type system catching up rather than a claim about the runtime.
    await track.applyConstraints({
      advanced: [{ zoom: clamped }],
    } as unknown as MediaTrackConstraints);
    return true;
  } catch (err) {
    console.warn('[camera] hardware zoom refused', err);
    return false;
  }
}
