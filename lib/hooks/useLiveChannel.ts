'use client';

/**
 * The whole engagement layer of a live session, on one hook.
 *
 * Chat, emoji reactions and the viewer count all travel on the same Supabase
 * Realtime channel (`live:<session_id>`), and both live screens — the
 * creator's studio and the viewer's watch page — need all three. So the
 * channel is opened once here rather than by each component that reads from
 * it: three components each calling openLiveChannel would be three
 * subscriptions to the same topic, three presence entries for one person, and
 * a viewer count that counted everybody three times.
 *
 * Deliberately independent of how the video is delivered. That is the point of
 * the redesign: the transport underneath survived LiveKit-to-Bunny and will
 * survive whatever replaces Bunny, because chat was never really about video.
 *
 * Everything here is ephemeral. Nothing is written to Postgres, so a viewer
 * who arrives late sees an empty panel and everything is gone when the tab
 * closes — the same contract as the LiveKit data channel this replaces, and
 * still a decision rather than an omission.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import {
  openLiveChannel,
  type LiveChannelSender,
  type LiveChannelStatus,
} from '@/lib/live/realtime';
import { MAX_CHAT_LENGTH, MAX_CHAT_MESSAGES } from '@/lib/live/constants';
import {
  MAX_ONSCREEN_REACTIONS,
  newFloatingReaction,
  type FloatingReaction,
} from '@/lib/live/reactions';
import type { LiveChatEntry } from '@/lib/live/types';

/** Reactions are swept in one pass rather than with 50 individual timeouts. */
const SWEEP_MS = 500;

export interface UseLiveChannelOptions {
  /** Null until the session is known; the hook stays idle until then. */
  sessionId: string | null;
  /** The signed-in viewer's auth user id. Null until it resolves. */
  userId: string | null;
  displayName: string;
  /** True on the creator's own studio screen. */
  isCreator?: boolean;
  /**
   * Whose lines get the 👑, from live-get-playback-url.
   *
   * The server's answer, compared against the id each sender claims. See the
   * security note in lib/live/realtime.ts for why this is a comparison rather
   * than a trusted flag on the message.
   */
  creatorUserId?: string | null;
}

export interface UseLiveChannelResult {
  chat: LiveChatEntry[];
  reactions: FloatingReaction[];
  /** How many viewers are on the channel. Excludes the broadcaster. */
  viewerCount: number;
  /**
   * The highest count seen this session.
   *
   * Tracked here, where the counts arrive, rather than derived by a consumer:
   * a peak recomputed in an effect from the current count is a cascading
   * render on every join and leave, and the number is only ever read.
   */
  peakViewerCount: number;
  /** False until the subscription settles; the inputs stay disabled. */
  connected: boolean;
  /**
   * Why the inputs are disabled, when they are.
   *
   * 'error' means the server refused the channel — almost always the
   * realtime.messages policies, i.e. no access token on the join or a viewer
   * without an entitlement. It needs different copy from 'connecting', and it
   * is the difference between a chat panel that is about to work and one that
   * never will.
   */
  status: LiveChannelStatus;
  sendChat: (text: string) => Promise<void>;
  sendReaction: (emoji: string) => void;
}

export function useLiveChannel({
  sessionId,
  userId,
  displayName,
  isCreator = false,
  creatorUserId = null,
}: UseLiveChannelOptions): UseLiveChannelResult {
  const [chat, setChat] = useState<LiveChatEntry[]>([]);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [viewerCount, setViewerCount] = useState(0);
  const [peakViewerCount, setPeakViewerCount] = useState(0);
  const [status, setStatus] = useState<LiveChannelStatus>('connecting');

  const senderRef = useRef<LiveChannelSender | null>(null);
  /** Payloads carry no id, and two can share a millisecond. */
  const seqRef = useRef(0);

  const nextId = () => {
    seqRef.current += 1;
    return `x${seqRef.current}`;
  };

  const trackViewerCount = useCallback((count: number) => {
    setViewerCount(count);
    setPeakViewerCount((current) => Math.max(current, count));
  }, []);

  const spawnReaction = useCallback((emoji: string) => {
    setReactions((current) => {
      // Dropped rather than queued once the screen is full: a reaction that
      // arrives after the moment it was a reaction to is noise, and 50
      // concurrent animations is where a mid-range phone starts losing frames.
      if (current.length >= MAX_ONSCREEN_REACTIONS) return current;
      return [...current, newFloatingReaction(nextId(), emoji)];
    });
  }, []);

  const appendChat = useCallback((entry: Omit<LiveChatEntry, 'id'>) => {
    // Oldest dropped rather than kept: this is the entire history there is,
    // and an unbounded array on a three-hour broadcast is a leak.
    setChat((current) => [...current, { ...entry, id: nextId() }].slice(-MAX_CHAT_MESSAGES));
  }, []);

  /**
   * `creatorUserId` and `displayName` are read through a ref rather than being
   * dependencies of the effect below.
   *
   * Both settle a moment after the session does — the creator id comes back
   * with the playback URL, the display name with the profile — and rebuilding
   * the channel when either lands would drop the subscription, re-announce
   * presence, and briefly halve everyone's viewer count for no reason.
   */
  /**
   * The browser client, resolved once.
   *
   * Held here rather than fetched inside the effect so that a misconfigured
   * environment — which can never resolve — is a DERIVED status below instead
   * of a setState in the effect body. The video is the feature; a live with no
   * chat is worth more than a screen that refuses to render.
   */
  const supabase = useMemo(() => {
    try {
      return getBrowserSupabase();
    } catch {
      return null;
    }
  }, []);

  const latest = useRef({ displayName, creatorUserId, isCreator });
  useEffect(() => {
    latest.current = { displayName, creatorUserId, isCreator };
  }, [displayName, creatorUserId, isCreator]);

  useEffect(() => {
    if (!sessionId || !userId || !supabase) return;

    /**
     * Opening the channel is asynchronous now, because the access token has to
     * reach the socket BEFORE the join is sent — see openLiveChannel. So the
     * effect can be torn down mid-open, and the channel it was waiting for has
     * to be closed rather than left subscribed to a session the viewer has
     * already navigated away from.
     */
    let cancelled = false;
    let close: (() => void) | null = null;

    void openLiveChannel(
      supabase,
      sessionId,
      { userId, displayName: latest.current.displayName, isCreator: latest.current.isCreator },
      {
        onChat: (entry) =>
          appendChat({
            text: entry.text,
            sender: entry.sender,
            timestamp: entry.timestamp,
            senderId: entry.senderId,
            isCreator:
              latest.current.creatorUserId !== null &&
              entry.senderId === latest.current.creatorUserId,
            isSelf: false,
          }),
        onReaction: (entry) => spawnReaction(entry.emoji),
        onViewerCount: trackViewerCount,
        onStatusChange: (next) => {
          if (!cancelled) setStatus(next);
        },
      },
    )
      .then((channel) => {
        if (cancelled) {
          channel.close();
          return;
        }
        senderRef.current = channel.sender;
        close = channel.close;
      })
      .catch((err) => {
        console.error('[useLiveChannel] failed to open channel', err);
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
      senderRef.current = null;
      close?.();
    };
  }, [supabase, sessionId, userId, appendChat, spawnReaction, trackViewerCount]);

  // Only runs while something is on screen: an idle broadcast should not have
  // a timer ticking for three hours.
  useEffect(() => {
    if (reactions.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setReactions((current) => current.filter((reaction) => reaction.expiresAt > now));
    }, SWEEP_MS);
    return () => clearInterval(timer);
  }, [reactions.length]);

  /**
   * Send, and echo locally.
   *
   * The channel is opened with `self: false`, so a sender never receives their
   * own broadcast — without the echo the sender would be the one person who
   * cannot see their own message. Same shape as the optimistic append the
   * LiveKit version did, for the same reason.
   */
  const sendChat = useCallback(
    async (text: string) => {
      const trimmed = text.trim().slice(0, MAX_CHAT_LENGTH);
      if (trimmed === '') return;
      // Thrown rather than dropped: LiveChat keeps the text in the box when a
      // send fails, so the message survives and Enter retries it. Returning
      // quietly here would clear the box and lose it.
      if (!senderRef.current) throw new Error('Chat channel is not connected');

      await senderRef.current.sendChat(trimmed);
      appendChat({
        text: trimmed,
        sender: latest.current.displayName,
        timestamp: Date.now(),
        senderId: null,
        isCreator: latest.current.isCreator,
        isSelf: true,
      });
    },
    [appendChat],
  );

  const sendReaction = useCallback(
    (emoji: string) => {
      spawnReaction(emoji);
      // Fire and forget: the local emoji has already flown, and a failed
      // packet costs the other viewers one heart rather than costing this
      // viewer their tap. There is no toast system in this repo to raise it in.
      void senderRef.current?.sendReaction(emoji).catch((err) => {
        console.error('[useLiveChannel] sendReaction failed', err);
      });
    },
    [spawnReaction],
  );

  const effectiveStatus: LiveChannelStatus = supabase ? status : 'error';

  return {
    chat,
    reactions,
    viewerCount,
    peakViewerCount,
    connected: effectiveStatus === 'connected',
    status: effectiveStatus,
    sendChat,
    sendReaction,
  };
}
