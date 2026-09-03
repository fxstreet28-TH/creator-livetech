'use client';

/**
 * Chat and emoji reactions, on a Supabase Realtime broadcast channel.
 *
 * They used to ride the LiveKit data channel, which worked because every
 * viewer was in the room. Under LL-HLS they are not — a viewer is an HTTP
 * request to a CDN — so the room is no longer a place everyone can be reached.
 * This module is the replacement transport, and it is deliberately independent
 * of how the video gets anywhere: it is the same channel whether the session
 * is delivered over LL-HLS or (during the transition) over LiveKit, so the
 * engagement layer survives the next change of video vendor too.
 *
 * WHAT IS THE SAME AS BEFORE
 *
 * Nothing is written to Postgres. A reaction exists for the three seconds it
 * takes to float up the screen; a chat line exists until the tab closes. A
 * viewer who joins late sees an empty panel. That was a decision under LiveKit
 * and it is still the decision here — `broadcast` rather than
 * `postgres_changes` is what encodes it.
 *
 * Every field is re-validated on receive, for the same reason decodeChat did
 * it: a broadcast payload is arbitrary JSON from another client.
 *
 * WHAT IS DIFFERENT, AND IT MATTERS
 *
 * LiveKit attached a server-asserted identity to every data packet, so the 👑
 * on a chat line was a fact. A broadcast payload is written entirely by its
 * sender, so `user_id` here is a CLAIM. The channel is opened as `private`, so
 * only people entitled to watch this session can send or receive at all (the
 * realtime.messages policies in 20260901_bunny_live_migration.sql), and the
 * badge is only granted when the claimed id matches the creator id the SERVER
 * told us in live-get-playback-url — so impersonating the creator requires
 * already being entitled to watch AND knowing an id that is not displayed
 * anywhere. That is a real reduction in assurance from LiveKit and it is worth
 * being honest about: it is a speed bump, not a signature.
 * TODO(post-launch): sign chat lines server-side, or relay them through an
 * Edge Function that stamps the sender.
 *
 * IT ALSO COUNTS THE AUDIENCE
 *
 * Presence on this channel is how the platform knows how many people are
 * watching, now that they are not room participants. It is a better number
 * than the LiveKit one it replaces: Realtime drops a presence entry when the
 * socket closes, so the count goes DOWN when someone leaves — which
 * `current_viewer_count` never did before. Keyed on the user id, so one person
 * with the stream open in two tabs is one viewer.
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { MAX_CHAT_LENGTH } from './constants';
import { decodeGiftEvent, type LiveGiftEvent } from './gifts';
import { isReactionEmoji } from './reactions';

/** One channel per live session. Parsed back into a UUID by the RLS policies. */
export function liveChannelName(sessionId: string): string {
  return `live:${sessionId}`;
}

/** The broadcast events the channel carries. */
export const LIVE_EVENT_CHAT = 'chat';
export const LIVE_EVENT_REACTION = 'reaction';
/**
 * A น้อง Aurum gift.
 *
 * Unlike the other two, nothing in this module SENDS one: gifts are written by
 * `live_gifts_broadcast`, a trigger on the INSERT that `send_live_gift`
 * performs, so the event and the row cannot disagree. A viewer spends stars
 * through the `live-send-gift` Edge Function (lib/live/gifts.ts) and then waits
 * for this event like everybody else — which is what makes the sender's screen
 * show the same thing, at the same moment, as the creator's.
 *
 * It rides this channel rather than one of its own because the topic is already
 * private and already gated by exactly the right rule: `can_watch_live_session`
 * on `realtime.messages`, written per topic and not per event. A second channel
 * would be a second subscription, a second presence entry inflating the viewer
 * count, and a second authorisation path to keep in step with this one.
 */
export const LIVE_EVENT_GIFT = 'gift';

/** What travels in a broadcast payload. Both events share the envelope. */
export interface LiveMessage {
  type: 'chat' | 'reaction';
  /** The sender's auth user id, as CLAIMED by the sender. See the header. */
  user_id: string;
  /** What they call themselves. Never trusted, always truncated. */
  display_name: string;
  /** Chat text, or one emoji from REACTION_OPTIONS. */
  payload: string;
  /** Sender's clock, so a late reaction can be aged out rather than animated. */
  ts: number;
}

export interface LiveChatReceived {
  text: string;
  sender: string;
  senderId: string;
  timestamp: number;
}

export interface LiveReactionReceived {
  emoji: string;
  senderId: string;
  timestamp: number;
}

/**
 * Read an arbitrary broadcast payload as a message of the expected kind, or
 * null.
 *
 * The `expected` argument is not redundant with the channel event name: a
 * client can send anything under any event, and the panel that renders chat
 * must not be reachable by a payload that claims to be a reaction.
 */
function decodeMessage(raw: unknown, expected: LiveMessage['type']): LiveMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = raw as Partial<LiveMessage>;
  if (message.type !== expected) return null;
  if (typeof message.payload !== 'string') return null;

  return {
    type: expected,
    user_id: typeof message.user_id === 'string' ? message.user_id.slice(0, 64) : '',
    display_name:
      typeof message.display_name === 'string' && message.display_name.trim() !== ''
        ? message.display_name.slice(0, 40)
        : 'ผู้ชม',
    payload: message.payload,
    ts:
      typeof message.ts === 'number' && Number.isFinite(message.ts) ? message.ts : Date.now(),
  };
}

/**
 * Where the subscription is.
 *
 * Not a boolean. A boolean cannot tell "still connecting" apart from "the
 * server refused this channel", and those need opposite responses from the UI:
 * one is a spinner, the other is "reload the page". The first version of this
 * collapsed both into `connected: false`, which is how an authorization
 * failure would have presented as an input that stayed greyed out forever.
 */
export type LiveChannelStatus = 'connecting' | 'connected' | 'error' | 'closed';

export interface LiveChannelHandlers {
  onChat?: (entry: LiveChatReceived) => void;
  onReaction?: (entry: LiveReactionReceived) => void;
  /** Told whenever the subscription changes state, with the reason on failure. */
  onStatusChange?: (status: LiveChannelStatus, error?: Error) => void;
  /** How many viewers are on the channel, excluding the broadcaster. */
  onViewerCount?: (count: number) => void;
  /**
   * A gift landed. Validated and clamped by decodeGiftEvent before it gets
   * here; de-duplication is the queue's job, not the transport's, because a
   * reconnect can replay an event this layer has no memory of.
   */
  onGift?: (event: LiveGiftEvent) => void;
}

export interface LiveChannelSender {
  sendChat: (text: string) => Promise<void>;
  sendReaction: (emoji: string) => Promise<void>;
}

export interface LiveChannelIdentity {
  userId: string;
  displayName: string;
  /**
   * True on the broadcaster's screen.
   *
   * Two effects: the creator is not counted in their own audience, and their
   * presence entry marks them so viewers do not count them either.
   */
  isCreator?: boolean;
}

/** What each participant publishes about themselves. */
interface LivePresence {
  role: 'creator' | 'viewer';
}

/**
 * Join the session's channel.
 *
 * `self: false` — a sender does not get their own broadcasts back, exactly as
 * LiveKit did not echo a participant's own data packets. Both callers already
 * append their own message optimistically, and turning self-echo on would
 * double every line.
 *
 * Returns a disposer. It must be called: an un-removed channel keeps a
 * WebSocket subscription open for the life of the tab, and a viewer who
 * watches four streams in a row would end up in four channels.
 */
export async function openLiveChannel(
  supabase: SupabaseClient,
  sessionId: string,
  identity: LiveChannelIdentity,
  handlers: LiveChannelHandlers,
): Promise<{ sender: LiveChannelSender; viewerCount: () => number; close: () => void }> {
  /**
   * AWAITED, and that is the whole point of this function being async.
   *
   * `subscribe()` reads `socket.accessTokenValue` SYNCHRONOUSLY when it builds
   * the join payload, and only attaches an `access_token` if one is already
   * there. `setAuth()` is async — it reads the session out of storage — so
   * firing it without awaiting and then subscribing in the same tick races: the
   * join can go out with no token at all, `auth.uid()` is then null inside the
   * realtime.messages policies, `can_watch_live_session` returns false, and the
   * channel is refused. The first version did exactly that.
   *
   * The failure is swallowed rather than thrown: an expired token should
   * surface as a channel error from the server, which says something useful,
   * not as an exception here that takes the video down with the chat.
   */
  // Announced before the first await so a caller that re-opens the channel for
  // a new session shows "connecting" from the same instant the old channel
  // stops being the one on screen. The transport reporting its own state is
  // also what keeps the consumer free of setState-in-effect.
  handlers.onStatusChange?.('connecting');

  try {
    await supabase.realtime.setAuth();
  } catch (err) {
    console.error('[live/realtime] setAuth failed', err);
  }

  const channel: RealtimeChannel = supabase.channel(liveChannelName(sessionId), {
    config: {
      private: true,
      broadcast: {
        self: false,
        // Wait for the server to acknowledge a broadcast. Without it `send()`
        // resolves 'ok' the instant it is queued, so a message the server
        // rejected is indistinguishable from one it delivered — which is the
        // other half of how a broken channel stays invisible.
        ack: true,
      },
      // Keyed on the user id so one person watching in two tabs is one
      // viewer. The default key is per-connection, which would count them
      // twice and inflate the number the cost estimate is built on.
      presence: { key: identity.userId },
    },
  });

  channel
    .on('broadcast', { event: LIVE_EVENT_CHAT }, ({ payload }) => {
      const message = decodeMessage(payload, 'chat');
      if (!message) return;
      const text = message.payload.slice(0, MAX_CHAT_LENGTH).trim();
      // An empty line is not a message. Dropped rather than rendered as a
      // blank bubble, which is what an unbounded whitespace payload would be.
      if (text === '') return;
      handlers.onChat?.({
        text,
        sender: message.display_name,
        senderId: message.user_id,
        timestamp: message.ts,
      });
    })
    .on('broadcast', { event: LIVE_EVENT_REACTION }, ({ payload }) => {
      const message = decodeMessage(payload, 'reaction');
      // The emoji check is the important one: this string goes straight onto
      // the video overlay, and an open field would let one viewer paste a
      // paragraph — or a run of combining characters — over everyone's screen.
      if (!message || !isReactionEmoji(message.payload)) return;
      handlers.onReaction?.({
        emoji: message.payload,
        senderId: message.user_id,
        timestamp: message.ts,
      });
    })
    .on('broadcast', { event: LIVE_EVENT_GIFT }, ({ payload }) => {
      // Belt and braces on the topic: `self: false` stops a sender's own
      // broadcasts coming back, but a gift arrives from a trigger rather than
      // from any client, so every screen INCLUDING the sender's receives it —
      // and one channel object can outlive a navigation between two sessions.
      const gift = decodeGiftEvent(payload);
      if (!gift || gift.session_id !== sessionId) return;
      handlers.onGift?.(gift);
    })
    .on('presence', { event: 'sync' }, () => {
      handlers.onViewerCount?.(countViewers(channel));
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        handlers.onStatusChange?.('connected');
        // Tracked only once subscribed: a track() before the join is
        // acknowledged is dropped, and the viewer would then be invisible to
        // everyone else's count for the whole broadcast.
        void channel
          .track({ role: identity.isCreator ? 'creator' : 'viewer' } satisfies LivePresence)
          .catch((trackErr) => console.error('[live/realtime] presence track failed', trackErr));
        return;
      }

      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // The overwhelmingly likely cause is the realtime.messages policies
        // refusing this topic — a missing access token, or a viewer who is not
        // entitled to this session. `err.cause` usually carries the server's
        // own reason, so it is logged rather than summarised away.
        console.error(`[live/realtime] channel ${status} on ${liveChannelName(sessionId)}`, err);
        handlers.onStatusChange?.('error', err ?? undefined);
        return;
      }

      if (status === 'CLOSED') handlers.onStatusChange?.('closed');
    });

  const send = async (type: LiveMessage['type'], payload: string) => {
    const message: LiveMessage = {
      type,
      user_id: identity.userId,
      display_name: identity.displayName.slice(0, 40),
      payload,
      ts: Date.now(),
    };
    // With `ack: true` this resolves to the server's verdict rather than to
    // 'ok' on queue, so a rejected message can be reported instead of
    // disappearing.
    const result = await channel.send({ type: 'broadcast', event: type, payload: message });
    if (result !== 'ok') {
      throw new Error(`Broadcast ${type} was not accepted: ${result}`);
    }
  };

  return {
    /** The audience right now, for a caller that wants it before the first sync. */
    viewerCount: () => countViewers(channel),
    sender: {
      sendChat: (text) => send('chat', text.slice(0, MAX_CHAT_LENGTH)),
      sendReaction: (emoji) => send('reaction', emoji),
    },
    close: () => {
      void supabase.removeChannel(channel);
    },
  };
}

/**
 * Everyone present who is not the broadcaster.
 *
 * A presence key can carry several entries — the same user id joining from two
 * devices, or a stale entry that has not expired yet — so a key counts once,
 * and counts as a creator if ANY of its entries says so. Being wrong in that
 * direction is right: it can only ever leave the creator out of their own
 * audience, never double-count a viewer as one.
 */
function countViewers(channel: RealtimeChannel): number {
  const state = channel.presenceState<LivePresence>();
  let viewers = 0;
  for (const entries of Object.values(state)) {
    const isCreator = entries.some((entry) => entry.role === 'creator');
    if (!isCreator) viewers += 1;
  }
  return viewers;
}
