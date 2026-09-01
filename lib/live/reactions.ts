/**
 * Emoji reactions: the palette, the pacing, and the shape of one on screen.
 *
 * They used to travel over the LiveKit data channel. Since the LL-HLS
 * migration viewers are not in a room, so the transport is a Supabase Realtime
 * broadcast channel — see ./realtime.ts, which owns the wire format. What is
 * left here is the domain: which emoji exist, how fast one participant may
 * send them, and how many may be on screen at once.
 *
 * The contract that has not changed: nothing is written to Postgres. A
 * reaction exists for the three seconds it takes to float up the screen and
 * then it is gone — there is no history to join late into, and no count
 * anywhere. Aggregating them for analytics is a separate feature with a
 * separate write path, not a flag on this one.
 */

/**
 * The palette a viewer can throw, in the order the buttons render.
 *
 * Closed by design, and re-checked on receive: an emoji is rendered straight
 * into the video overlay, and an open field would let one participant paste a
 * paragraph — or a run of combining characters — into everyone else's screen.
 * Six is also the most that fits down the side of a phone-width player.
 */
export const REACTION_OPTIONS = [
  { emoji: '❤️', label: 'ส่งหัวใจ' },
  { emoji: '🔥', label: 'ส่งไฟ' },
  { emoji: '👏', label: 'ปรบมือ' },
  { emoji: '😂', label: 'ส่งฮา' },
  { emoji: '⭐', label: 'ส่งดาว' },
  { emoji: '💯', label: 'ส่งสุดยอด' },
] as const;

export type ReactionEmoji = (typeof REACTION_OPTIONS)[number]['emoji'];

const ALLOWED_EMOJI = new Set<string>(REACTION_OPTIONS.map((option) => option.emoji));

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === 'string' && ALLOWED_EMOJI.has(value);
}

/**
 * Ceiling on how many reactions one participant may send per second.
 *
 * Client-side only, and deliberately so: this is politeness plus a brake on an
 * accidental flood (a stuck finger, a trackpad with a repeat), not a security
 * boundary — a modified client can ignore it, and Supabase Realtime's own
 * per-connection message limits are what actually stand behind it. The
 * on-screen cap below is the thing that keeps a hostile sender from costing
 * every other viewer their frame rate.
 */
export const MAX_REACTIONS_PER_SECOND = 10;

/** How many float at once before new ones are dropped, across all senders. */
export const MAX_ONSCREEN_REACTIONS = 50;

/** How long one reaction takes to cross the video. Matches the CSS keyframes. */
export const REACTION_RISE_MS = 3_000;

/** Long-press repeat — 3 per second, comfortably under the throttle. */
export const LONG_PRESS_INTERVAL_MS = 333;

/** How long a press is held before it starts repeating. */
export const LONG_PRESS_DELAY_MS = 350;

/**
 * A sliding one-second window. Returns false when the caller has already spent
 * its allowance, which is the signal to drop the reaction rather than queue it
 * — a queued reaction arrives after the moment it was a reaction to.
 */
export function createReactionThrottle(maxPerSecond = MAX_REACTIONS_PER_SECOND): () => boolean {
  const sent: number[] = [];
  return () => {
    const now = Date.now();
    while (sent.length > 0 && now - sent[0] >= 1_000) sent.shift();
    if (sent.length >= maxPerSecond) return false;
    sent.push(now);
    return true;
  };
}

/**
 * One reaction as the overlay draws it.
 *
 * Lives here rather than beside the component because two things build these
 * now — a received broadcast, and the local echo a sender needs because the
 * channel does not send them their own messages back.
 */
export interface FloatingReaction {
  /** Local and monotonic: payloads carry no id and two can share a millisecond. */
  id: string;
  emoji: string;
  /** Where it starts, as a percentage of the video width. */
  leftPct: number;
  /** Amplitude of the horizontal sine, in px. Signed. */
  driftPx: number;
  /** When it may be dropped from the list. */
  expiresAt: number;
}

/**
 * Where one reaction starts and how it sways.
 *
 * Randomised so two simultaneous hearts do not travel as one column. The
 * centre 60% of the width, because the edges are where the live badge, the
 * viewer count and the reaction buttons themselves live.
 */
export function newFloatingReaction(id: string, emoji: string): FloatingReaction {
  return {
    id,
    emoji,
    leftPct: 20 + Math.random() * 60,
    // ±10-26px. Enough to separate them, small enough to stay inside the
    // video on a phone.
    driftPx: (10 + Math.random() * 16) * (Math.random() < 0.5 ? -1 : 1),
    expiresAt: Date.now() + REACTION_RISE_MS,
  };
}
