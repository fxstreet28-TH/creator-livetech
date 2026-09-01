/**
 * Client-side bounds and options for the live streaming screens.
 *
 * Same contract as lib/creator/constants.ts: the values duplicated from the
 * backend are here on purpose, because a form that only learns a rule from a
 * rejected round trip is a worse form. `check_creator_can_golive` and the
 * `live_sessions` CHECK constraints stay the authority — drift here costs a
 * confusing message, never a bad row.
 *
 * The title and description bounds are imported from the creator constants
 * rather than redeclared: a live title and a post title are the same field in
 * the same UI, and two copies drift.
 */

import type { BroadcastQuality, LatencyMode } from './types';

export { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH, MIN_TITLE_LENGTH } from '@/lib/creator/constants';

/** Lowest to highest. The backend clamps a request to the tier cap using the same order. */
export const QUALITY_ORDER: BroadcastQuality[] = ['360p', '480p', '720p', '1080p'];

/** What the form starts on, and the fallback when a tier cap is unreadable. */
export const DEFAULT_QUALITY: BroadcastQuality = '720p';

export function isBroadcastQuality(value: unknown): value is BroadcastQuality {
  return typeof value === 'string' && (QUALITY_ORDER as string[]).includes(value);
}

/** True when `quality` is at or below the creator's tier cap. */
export function isQualityAllowed(quality: BroadcastQuality, maxQuality: BroadcastQuality): boolean {
  return QUALITY_ORDER.indexOf(quality) <= QUALITY_ORDER.indexOf(maxQuality);
}

export interface QualityOption {
  value: BroadcastQuality;
  label: string;
  /** Capture height handed to getUserMedia. Width follows from 16:9. */
  height: number;
  /**
   * The cheapest tier whose `max_live_quality` reaches this, from the seeded
   * content_tier_limits (free 360p, pro 720p, star/enterprise 1080p). Shown on
   * a disabled option so a creator knows what would unlock it.
   */
  minTierLabel: string;
}

/**
 * The four choices on the go-live form, in the order they render.
 *
 * 480p has no tier of its own — nothing caps at it — so it comes with Pro,
 * the first tier that reaches past 360p.
 */
export const QUALITY_OPTIONS: QualityOption[] = [
  { value: '360p', label: '360p (ประหยัดเน็ต)', height: 360, minTierLabel: 'Free' },
  { value: '480p', label: '480p', height: 480, minTierLabel: 'Pro' },
  { value: '720p', label: '720p (แนะนำ)', height: 720, minTierLabel: 'Pro' },
  { value: '1080p', label: '1080p (คมชัดสูง)', height: 1080, minTierLabel: 'Star' },
];

export function qualityOption(quality: BroadcastQuality): QualityOption {
  return QUALITY_OPTIONS.find((option) => option.value === quality) ?? QUALITY_OPTIONS[2];
}

/**
 * How close to the live edge the viewer's player sits.
 *
 * Separate from quality on purpose — they trade off against different things.
 * Quality costs bandwidth; latency costs robustness. 'low_latency' is the
 * default because it is the 2-5s the product promises and the figure the cost
 * model is built on; 'standard' is the fallback to reach for when a stream
 * stutters, rather than abandoning LL-HLS.
 */
export const DEFAULT_LATENCY_MODE: LatencyMode = 'low_latency';

export function isLatencyMode(value: unknown): value is LatencyMode {
  return value === 'ultra_low' || value === 'low_latency' || value === 'standard';
}

/** Roughly what a viewer will see, per mode. Shown on the go-live form. */
export const LATENCY_LABELS: Record<LatencyMode, string> = {
  ultra_low: 'เร็วที่สุด (~2 วินาที)',
  low_latency: 'สมดุล (~3-5 วินาที)',
  standard: 'เสถียรที่สุด (~6 วินาที)',
};

/**
 * How long the broadcaster waits after connecting before asking the backend to
 * start the egress.
 *
 * Not zero: LiveKit's RoomComposite egress renders whatever is in the room at
 * the instant it starts, and starting it in the same tick as the first
 * published track can catch a frame before the camera track is up — which
 * Bunny then serves as the stream's opening second of black.
 */
export const EGRESS_START_DELAY_MS = 1_500;

/**
 * How long a signed playback URL is refreshed before it lapses.
 *
 * live-get-playback-url mints them with a one-hour TTL, and a 60-minute
 * broadcast is an explicit success criterion — so a viewer who never refreshes
 * would lose the stream on the hour. Refreshed at 50 minutes, which leaves ten
 * minutes of headroom for a retry.
 */
export const PLAYBACK_REFRESH_MS = 50 * 60 * 1_000;

/**
 * How often a viewer checks whether the broadcast is still running.
 *
 * An HLS viewer is never told that it stopped — the playlist just stops
 * growing, which looks the same as a creator whose upload stalled — so the
 * session row is polled. Fifteen seconds is the trade: fast enough that
 * "ไลฟ์จบแล้ว" lands while the viewer is still looking at the screen, slow
 * enough that a thousand concurrent viewers are 66 reads a second and not a
 * thousand.
 */
export const LIVE_STATUS_POLL_MS = 15_000;

/** live_sessions.ppv_price_stars — same bounds as a PPV post. */
export { MAX_PPV_PRICE_STARS, MIN_PPV_PRICE_STARS } from '@/lib/creator/constants';

/** One chat line. Long enough for a sentence, short enough not to flood a panel. */
export const MAX_CHAT_LENGTH = 200;

/**
 * How many chat lines stay in memory. Chat is ephemeral (non-negotiable #6),
 * so this is the whole history there is — an unbounded array on a three-hour
 * broadcast is a leak.
 */
export const MAX_CHAT_MESSAGES = 100;

/**
 * How often the viewer count on screen is recomputed.
 *
 * Since the LL-HLS migration the broadcaster's LiveKit room contains the
 * publisher and the egress worker and NOT the audience, so the count no longer
 * comes from participant events. It comes from Realtime presence on the
 * `live:<session_id>` channel, which is push-based — so nothing polls it and
 * this constant is only the cadence at which a screen refreshes derived
 * numbers.
 *
 * SCALE NOTE, worth watching in the load test: a presence sync sends the whole
 * roster to every subscriber, so its cost grows with the square of the
 * audience. It is comfortable in the low hundreds and is the thing to measure
 * first if a 500-viewer stream feels heavy — the fix would be to stop tracking
 * presence above a threshold and fall back to a sampled count, not to go back
 * to a counter that only ever climbs.
 */
export const VIEWER_COUNT_POLL_MS = 5_000;

/**
 * How often the broadcaster writes the counts back to Postgres.
 *
 * Much slower than the on-screen refresh on purpose: the row only feeds the
 * discover card and the end-of-session summary, and one UPDATE every five
 * seconds for the length of a broadcast is a lot of writes for a number
 * nobody reads that often.
 */
export const VIEWER_PERSIST_MS = 30_000;

/**
 * Automatic reconnect attempts after LiveKit drops, before the broadcaster is
 * asked to retry by hand. livekit-client does its own internal retries first;
 * these are full reconnects on top of that, after it has given up.
 */
export const MAX_RECONNECT_ATTEMPTS = 3;

/** Backoff between those attempts. */
export const RECONNECT_DELAY_MS = 3_000;
