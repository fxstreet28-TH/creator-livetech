'use client';

/**
 * Opening a camera, and finding out what you actually got.
 *
 * WHY THIS IS A MODULE AND NOT A CONSTRAINTS OBJECT
 *
 * A creator broadcasting from an iPhone reported a picture zoomed 2-3x against
 * the native camera app — in the host preview AND in the published stream. The
 * canvas is not the culprit: it is sized to the track every frame and drawn
 * 1:1 (see createFilteredStream), so whatever the camera hands over is exactly
 * what viewers receive. That leaves getUserMedia, and getUserMedia on iOS
 * Safari does not answer the question you think you asked.
 *
 * TWO WAYS A CONSTRAINT BECOMES A ZOOM, and they need different fixes:
 *
 *  1. THE TRACK COMES BACK LANDSCAPE. Ask an upright phone for a portrait
 *     frame and Safari may still hand back 1280x720. Drawn into a portrait
 *     canvas under `object-fit: cover` that is a ~1.8x horizontal crop, and it
 *     is what the earlier fix was aimed at. The answer is to ASK AGAIN at a
 *     larger portrait size, and if it still refuses, to accept a landscape
 *     source and publish it as landscape rather than cover-cropping it into a
 *     portrait frame. A 16:9 broadcast is a worse phone experience than a 9:16
 *     one; a 16:9 broadcast with two thirds of the picture thrown away is not
 *     a broadcast at all.
 *
 *  2. THE TRACK COMES BACK PORTRAIT AND IS STILL A CROP. This is the one that
 *     is invisible without numbers. An iPhone sensor mode is 4:3; a 9:16
 *     `aspectRatio` ideal is satisfied by CROPPING that mode, not by
 *     letterboxing it, and a small `width`/`height` ideal can be satisfied by
 *     a centre crop at native pixel density rather than by downscaling the
 *     full field of view. Both produce a perfectly well-formed 720x1280 track
 *     that is a telephoto view of the room.
 *
 * WHICH ONE IS HAPPENING IS AN EMPIRICAL QUESTION, so this module records
 * every attempt — the constraints asked for, the settings returned, and the
 * track's own capabilities — and hands the report back for the debug chip and
 * the console. `getCapabilities().width.max` against `getSettings().width` is
 * the tell for case 2: a 720-wide track from a camera that can do 1920 wide,
 * with an aspectRatio that does not appear in the capability range, is a crop.
 *
 * NOTHING HERE APPLIES A CROP OF ITS OWN. 1x means the full field of view the
 * browser is willing to give, like the native camera app. Zoom is a separate,
 * explicit control — see applyZoomConstraint below and the digital fallback in
 * createFilteredStream.
 */

import type { BroadcastQuality } from './types';
import { resolutionFor, type CameraFacing } from './livekitClient';

/** One getUserMedia call and what came back. */
export interface CameraAttempt {
  /** Which rung of the ladder this was, for the report. */
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
  /**
   * Send `aspectRatio: { ideal: 9/16 }` on the portrait attempts.
   *
   * On by default because it is what makes a 4:3 camera hand back a 9:16
   * frame at all. Off is the A/B for case 2 in the header: if 1x stops being
   * zoomed with this off, the aspect ratio ideal was being satisfied by a
   * sensor crop, and the answer is to publish the camera's own ratio and let
   * the viewer's `object-fit: cover` do the framing. Exposed so the on-device
   * run can settle it in one tap rather than in another release.
   */
  aspectRatioHint?: boolean;
}

/** 9:16, as getUserMedia wants it: width over height. */
const PORTRAIT_ASPECT = 9 / 16;

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
 * The ladder, in the order it is tried. NO `exact` anywhere: an exact
 * constraint that a camera cannot meet is an OverconstrainedError, and a
 * broadcast that refuses to start is worse than one framed imperfectly.
 */
function ladderFor(options: OpenCameraOptions): { label: string; constraints: MediaTrackConstraints }[] {
  const { width, height, frameRate } = resolutionFor(options.quality);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const base = { ...identity(options), frameRate: { ideal: frameRate } };

  if (!options.portrait) {
    // Desktop. Unchanged, and deliberately unconstrained in aspect: a webcam
    // is 16:9 or 4:3 and either is fine in a framed player.
    return [
      {
        label: 'landscape',
        constraints: { ...base, width: { ideal: longEdge }, height: { ideal: shortEdge } },
      },
    ];
  }

  const aspect = options.aspectRatioHint === false ? {} : { aspectRatio: { ideal: PORTRAIT_ASPECT } };

  return [
    // 1. The size the quality rung means, upright.
    {
      label: 'portrait',
      constraints: { ...base, width: { ideal: shortEdge }, height: { ideal: longEdge }, ...aspect },
    },
    // 2. Bigger. A camera that answered a 720x1280 request with a landscape
    //    track often has a portrait mode further up its list, and asking for
    //    1080x1920 is what reaches it. It also side-steps the centre-crop
    //    case: a sensor asked for its own full height has nothing to crop to.
    {
      label: 'portrait-hd',
      constraints: { ...base, width: { ideal: 1080 }, height: { ideal: 1920 }, ...aspect },
    },
  ];
}

/**
 * Open a camera, escalating until it gives an upright frame or runs out of
 * things to try.
 *
 * Throws only when EVERY rung failed — the caller turns that into the Thai
 * media error. A rung that succeeds but returns the wrong orientation is not
 * a failure; it is an answer, and `portraitRefused` carries it.
 */
export async function openCamera(options: OpenCameraOptions): Promise<CameraOpenResult> {
  const attempts: CameraAttempt[] = [];
  let lastError: unknown = null;
  let fallback: { stream: MediaStream; settings: MediaTrackSettings } | null = null;

  for (const rung of ladderFor(options)) {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: rung.constraints,
        audio: options.audio !== false,
      });
    } catch (err) {
      lastError = err;
      attempts.push({
        label: rung.label,
        constraints: rung.constraints,
        settings: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      continue;
    }

    const [track] = stream.getVideoTracks();
    const settings = track?.getSettings() ?? {};
    attempts.push({ label: rung.label, constraints: rung.constraints, settings, error: null });

    const orientation = orientationOf(settings);
    const wanted = options.portrait ? 'portrait' : 'landscape';

    if (!options.portrait || orientation !== 'landscape') {
      logReport(rung.label, attempts, settings, track);
      return {
        stream,
        settings,
        capabilities: readCapabilities(track),
        orientation,
        portraitRefused: false,
        attempts,
      };
    }

    // Wrong way up. Keep it as the fallback and try the next rung — but only
    // ONE camera may be open at a time on iOS, so the loser is released before
    // the next request rather than after.
    if (fallback) fallback.stream.getTracks().forEach((t) => t.stop());
    fallback = { stream, settings };
    void wanted;
  }

  if (fallback) {
    const [track] = fallback.stream.getVideoTracks();
    logReport('portrait-refused', attempts, fallback.settings, track);
    return {
      stream: fallback.stream,
      settings: fallback.settings,
      capabilities: readCapabilities(track),
      orientation: 'landscape',
      // The caller must publish landscape. Cover-cropping this into a portrait
      // canvas is the 2-3x zoom that started all of this.
      portraitRefused: true,
      attempts,
    };
  }

  throw lastError ?? new Error('No camera available');
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
  const ladder = attempts
    .map((a) => `${a.label}=${a.settings ? `${a.settings.width}x${a.settings.height}` : a.error}`)
    .join(' -> ');

  // One flat string, not format specifiers: this is read over a USB cable in
  // Safari's remote inspector on the phone that has the problem, and a line
  // that renders as "%s %d" there is a line nobody can use.
  console.info(
    `[camera] ${outcome}: ${settings.width ?? 0}x${settings.height ?? 0} ` +
      `ar=${aspectLabel(settings)} fps=${settings.frameRate ?? '?'} ` +
      `camMax=${capabilities?.width?.max ?? '?'}x${capabilities?.height?.max ?? '?'} ` +
      `| ladder: ${ladder}`,
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
