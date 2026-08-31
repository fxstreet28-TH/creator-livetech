/**
 * The "look" presets a creator can put on their camera.
 *
 * Pure CSS `filter:` strings applied to the <video> element that renders the
 * local track. No canvas, no WebGL, no face tracking, nothing that reads a
 * pixel — the browser compositor does all of it, which is why this costs
 * nothing on a machine that is already encoding a broadcast.
 *
 * IMPORTANT — this is a LOCAL preview effect only. A CSS filter styles the
 * element that paints the track; it does not touch the track. The frames
 * LiveKit encodes and sends come from the MediaStreamTrack, so viewers see the
 * raw camera. The creator sees the filter on their own screen and nowhere
 * else, and the UI says so (LOCAL_ONLY_NOTICE below) rather than letting them
 * find out from a viewer.
 *
 * TODO(post-launch): Implement canvas-based track processor to broadcast filter
 * to viewers. Current implementation is local-preview only — the filter would
 * have to be drawn to a canvas per frame and that canvas captured as the
 * published track, which means a requestAnimationFrame loop for the length of
 * the broadcast plus its own memory and mobile-thermal budget. That is a
 * feature, not a tweak. See livekit-client TrackProcessor API:
 * https://docs.livekit.io/client-sdk-js/interfaces/TrackProcessor.html
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

/** Shown wherever the presets are, so nobody ships a look they think viewers can see. */
export const LOCAL_ONLY_NOTICE =
  'ผู้ชมจะเห็นภาพต้นฉบับ • ฟิลเตอร์นี้แสดงเฉพาะสำหรับคุณ (จะแพร่ภาพจริงได้ในเวอร์ชั่นต่อไป)';
