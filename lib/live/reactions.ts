/**
 * Emoji reactions, as they travel over the LiveKit data channel.
 *
 * Same contract as chat (see LiveChatMessage in ./types): nothing here is
 * written to Postgres. A reaction exists for the three seconds it takes to
 * float up the screen and then it is gone — there is no history to join late
 * into, and no count anywhere. Aggregating them for analytics is a separate
 * feature with a separate write path, not a flag on this one.
 *
 * The packet shape and the byte encoding live here; the one line that hands
 * the bytes to the SDK lives in ./livekitClient, which stays the only file in
 * the app that talks to livekit-client.
 *
 * Reactions ride the same reliable data channel as chat and are told apart by
 * their `type` field — that field, not the topic, is what every receiver keys
 * off, so a packet that arrives on an unexpected topic is still routed
 * correctly. The separate topic is there so a receiver can ignore traffic it
 * does not care about without parsing it.
 */

/** The data-channel topic reactions travel on. Chat uses 'chat'. */
export const REACTION_TOPIC = 'reactions';

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

/** One reaction, on the wire. */
export interface ReactionPacket {
  type: 'reaction';
  /** One of REACTION_OPTIONS. Anything else is dropped on receive. */
  emoji: string;
  /**
   * The sender's LiveKit participant identity.
   *
   * Carried for a future moderation view, and NOT trusted: like the `sender`
   * name on a chat line this is whatever the sender wrote. The trustworthy
   * identity is the one LiveKit attaches to the DataReceived event, which the
   * server asserts.
   */
  sender_id: string;
  /** Client clock, so a late packet can be aged out rather than animated. */
  timestamp: number;
}

/**
 * Ceiling on how many reactions one participant may send per second.
 *
 * Client-side only, and deliberately so: this is politeness plus a brake on an
 * accidental flood (a stuck finger, a trackpad with a repeat), not a security
 * boundary — a modified client can ignore it, and LiveKit's own data-channel
 * limits are what actually stand behind that. The on-screen cap below is the
 * thing that keeps a hostile sender from costing every other viewer their
 * frame rate.
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Bytes for one reaction, ready for publishData.
 *
 * The `<ArrayBuffer>` argument is not decoration: livekit-client's publishData
 * takes `Uint8Array<ArrayBuffer>` specifically, and a bare `Uint8Array` widens
 * to `ArrayBufferLike` (which admits a SharedArrayBuffer) and is rejected.
 */
export function encodeReaction(emoji: string, senderId: string): Uint8Array<ArrayBuffer> {
  const packet: ReactionPacket = {
    type: 'reaction',
    emoji,
    sender_id: senderId.slice(0, 64),
    timestamp: Date.now(),
  };
  return encoder.encode(JSON.stringify(packet));
}

/**
 * Read a data packet as a reaction, or null if it is not one.
 *
 * Every field is re-validated rather than trusted, for the same reason
 * decodeChat does it: a data packet is arbitrary bytes from another
 * participant, and this app is not the only thing that can connect to a
 * LiveKit room. The emoji check is the important one — it is the only part of
 * the payload that reaches the screen.
 */
export function decodeReaction(payload: Uint8Array): ReactionPacket | null {
  try {
    const parsed = JSON.parse(decoder.decode(payload)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const packet = parsed as Partial<ReactionPacket>;
    if (packet.type !== 'reaction' || !isReactionEmoji(packet.emoji)) return null;

    return {
      type: 'reaction',
      emoji: packet.emoji,
      sender_id: typeof packet.sender_id === 'string' ? packet.sender_id.slice(0, 64) : '',
      timestamp:
        typeof packet.timestamp === 'number' && Number.isFinite(packet.timestamp)
          ? packet.timestamp
          : Date.now(),
    };
  } catch {
    return null;
  }
}

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
