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
 * Target publish bitrate per quality rung, in bits per second.
 *
 * THIS IS THE NUMBER THE COST MODEL IS BUILT ON.
 * BUNNY_LIVE_THB_PER_VIEWER_MINUTE in supabase/functions/_shared/live.ts
 * assumes the 720p rung, and letting the encoder pick its own ceiling would
 * make the projected bill fiction — so every publisher caps itself here rather
 * than trusting a default. That constant is a HAND-WRITTEN copy of the 720p
 * figure, not a computed one: it lives in a Deno edge function that cannot
 * import this module. Change a rung here and change it there in the same
 * commit, or the bill and the broadcast stop describing each other.
 *
 * It lives in constants rather than beside one publisher because there are now
 * two, and they must agree: the LiveKit publisher passes it as `videoEncoding
 * .maxBitrate`, and the WHIP publisher applies it with `RTCRtpSender
 * .setParameters` (see ./whipClient.ts). A rung that meant one bitrate on one
 * path and whatever-the-encoder-felt-like on the other would price the same
 * broadcast differently depending on a vault secret.
 *
 * It caps the INGEST, not what a viewer receives: both pipelines transcode or
 * remux downstream of this.
 *
 * ---------------------------------------------------------------------------
 * WHY 6 Mbps AT 720p, AND NOT 3.
 * ---------------------------------------------------------------------------
 *
 * 3 Mbps was chosen for a creator sitting still and talking, and for that it is
 * plenty. The 2026-09-09 test found where it stops being plenty, in three
 * stages over 80 seconds:
 *
 *   sitting still          — WHEP parity, no measurable delay
 *   picking up a phone,    — delay begins to ACCUMULATE
 *   rotating the camera
 *   screen share composite — heavy delay, stutter, frames dropped on the phone
 *
 * That is a bitrate ceiling being hit, not a transport fault. Motion costs
 * bits: the same picture moving needs several times the bits/second of the
 * picture at rest, and a composite — a candlestick chart at full detail
 * ALONGSIDE a face — is a busy frame everywhere at once, so it hits the
 * ceiling even at moderate motion. When an encoder hits a ceiling it can shed
 * quality, or it can let its send queue grow; a growing send queue IS
 * accumulating latency, which is precisely the symptom that was recorded. The
 * origin's own logs agree from the other end: `segment duration changed from
 * 2s to 3s` and repeated `RTP packets lost` are what a starved encoder looks
 * like to the server it is feeding.
 *
 * So the ceiling doubles at every rung, keeping the ladder's proportions. It
 * buys headroom, and headroom is what the accumulating delay was short of.
 *
 * WHAT IT COSTS: nothing, at this scale. The origin VPS includes 4 TB/month
 * and current usage is a rounding error against it, so the ingest side is free
 * until the audience is orders of magnitude larger. The Bunny line for
 * HLS-delivered viewers does double, and that is a real change to the modelled
 * bill — see the constant named above.
 *
 * WHAT IT DOES NOT FIX ON ITS OWN: a 6 Mbps ceiling is still a ceiling, and
 * very high motion will still reach it. Two companion changes make reaching it
 * graceful rather than stuttery — `degradationPreference` on the sender, and a
 * `contentHint` on each track — and the three are only a fix together.
 */
export function publishBitrateFor(quality: BroadcastQuality): number {
  switch (quality) {
    case '1080p':
      return 9_000_000;
    case '720p':
      return 6_000_000;
    case '480p':
      return 3_000_000;
    default:
      return 1_600_000;
  }
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
 * How often the broadcasting studio says it is still on air.
 *
 * THIS IS THE ONE THING THAT CLOSES AN ABANDONED SESSION. Nothing else in the
 * system can tell "the creator is broadcasting" from "the creator closed the
 * tab an hour ago": a LiveKit room outlives its publisher, an HLS playlist
 * that stops growing looks like a stalled upload, and `status` is only ever
 * written by somebody pressing "จบไลฟ์". So the studio states it, and
 * live-watchdog closes anything that stops saying it.
 *
 * 20s against the watchdog's 90s grace is four beats of headroom — a phone
 * changing cell or a laptop briefly sleeping must not end a live broadcast.
 * Changing either means changing both; the grace period is stated in
 * `live_watchdog_grace_seconds()` and in live-watchdog/index.ts.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * How stale a heartbeat has to be before a READER treats the session as over.
 *
 * The same 90 seconds the watchdog uses, and read on the two screens that
 * would otherwise show a broadcast that has stopped: the viewer page, which
 * would spin on "กำลังเชื่อมต่อ…" forever, and the dashboard's
 * "🔴 กำลังไลฟ์ตอนนี้" strip.
 *
 * They do not wait for the watchdog to write the row, because they cannot: a
 * cron job runs once a minute and the Edge Function it calls can be down, and
 * neither screen should be wrong for as long as that takes. The row is the
 * durable answer; this is the same conclusion drawn a minute earlier from the
 * same evidence.
 */
export const HEARTBEAT_STALE_MS = 90_000;

/**
 * True when a session claims to be on air but has stopped saying so.
 *
 * PASS A SERVER-ANCHORED `now`. The default is the device clock, and a device
 * running two minutes fast judges every live broadcast stale — which on the
 * watch page means "ไลฟ์จบแล้ว" painted over a stream that is running, and
 * unlike a missing card it does not correct itself: every poll reaches the
 * same wrong conclusion. useServerNow measures the offset once per page from
 * the `server_now()` RPC; useLiveWatch passes the corrected value.
 *
 * The live tab does not call this at all any more — the freshness cut for the
 * listing is made inside `list_discoverable_live_sessions`, on the database's
 * own clock, where it cannot skew.
 *
 * A NULL heartbeat is NOT stale. Two kinds of row have one: a session created
 * before this shipped, and one whose studio has not managed its first beat
 * yet — a second or two after go-live. Treating either as over would end
 * broadcasts that are fine, so the honest answer for "no evidence" is "not
 * stale" and the watchdog leaves those rows alone too.
 */
export function isBroadcastStale(
  lastHeartbeatAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!lastHeartbeatAt) return false;
  const beat = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(beat)) return false;
  return now - beat > HEARTBEAT_STALE_MS;
}

/**
 * Automatic reconnect attempts after LiveKit drops, before the broadcaster is
 * asked to retry by hand. livekit-client does its own internal retries first;
 * these are full reconnects on top of that, after it has given up.
 */
export const MAX_RECONNECT_ATTEMPTS = 3;

/** Backoff between those attempts. */
export const RECONNECT_DELAY_MS = 3_000;

/**
 * How long a WHIP publisher may sit in ICE `disconnected` before it is treated
 * as a broadcast that needs rescuing.
 *
 * `disconnected` is not a failure — it is the state a phone passes through on a
 * 5G handover, a WiFi-to-cellular switch or a lift ride, and it clears itself
 * within a second or two. Acting on it immediately would turn every one of
 * those into a visible reconnect. Acting on it NEVER is what shipped, and what
 * the origin-sg-1 logs show as `closed: peer connection closed` twenty seconds
 * after the first lost packets, with the creator still holding a phone that
 * says they are live.
 *
 * Four seconds is past the point where a handover recovers on its own and well
 * inside the ~30s the browser takes to declare `failed` by itself.
 */
export const WHIP_ICE_GRACE_MS = 4_000;
