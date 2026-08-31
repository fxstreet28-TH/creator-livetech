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

import type { BroadcastQuality } from './types';

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
 * LiveKit fires ParticipantConnected/Disconnected, and those are subscribed
 * to as well — this interval is the backstop that catches a participant that
 * left without a clean disconnect, whose event never arrives.
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
