'use client';

/**
 * The rising emoji overlay, shared by the broadcaster and the viewer screens.
 *
 * Two exports, because the two screens need different halves of it:
 *
 *  - useFloatingReactions(room) subscribes to the data channel and owns the
 *    list. The viewer screen also uses its `spawn` to echo its own taps —
 *    LiveKit does not deliver a participant's own data packets back to them,
 *    so without that local echo the sender is the one person who does not see
 *    their heart. That is the same optimistic-echo shape LiveChat uses.
 *  - FloatingReactionsLayer renders the list and nothing else.
 *
 * Splitting them this way keeps the overlay a pure function of the list, and
 * lets the reaction buttons sit somewhere else in the tree (they do — the
 * overlay is pointer-events-none across the whole video, and the buttons need
 * clicks).
 *
 * All of the animation is CSS (.aurum-reaction in globals.css). React's only
 * job per reaction is to mount a span and, three seconds later, unmount it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomEvent, type Room } from '@/lib/live/livekitClient';
import {
  MAX_ONSCREEN_REACTIONS,
  REACTION_RISE_MS,
  decodeReaction,
} from '@/lib/live/reactions';

export interface FloatingReaction {
  /** Local and monotonic: packets carry no id and two can share a millisecond. */
  id: string;
  emoji: string;
  /** Where it starts, as a percentage of the video width. */
  leftPct: number;
  /** Amplitude of the horizontal sine, in px. Signed. */
  driftPx: number;
  /** When it may be dropped from the list. */
  expiresAt: number;
}

/** Reactions are cleaned up in one sweep rather than 50 individual timeouts. */
const SWEEP_MS = 500;

export function useFloatingReactions(room: Room | null) {
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const seqRef = useRef(0);

  const spawn = useCallback((emoji: string) => {
    seqRef.current += 1;
    const id = `r${seqRef.current}`;
    // Start within the centre 60% of the width: the edges are where the live
    // badge, the viewer count and the reaction buttons themselves live.
    const leftPct = 20 + Math.random() * 60;
    // ±10-26px of sway. Enough that two simultaneous hearts do not travel as
    // one column, small enough to stay inside the video on a phone.
    const driftPx = (10 + Math.random() * 16) * (Math.random() < 0.5 ? -1 : 1);

    setReactions((current) => {
      // Dropped rather than queued once the screen is full: a reaction that
      // arrives after the moment it was a reaction to is noise, and 50
      // concurrent animations is already the point where a mid-range phone
      // starts costing the viewer frames.
      if (current.length >= MAX_ONSCREEN_REACTIONS) return current;
      return [
        ...current,
        { id, emoji, leftPct, driftPx, expiresAt: Date.now() + REACTION_RISE_MS },
      ];
    });
  }, []);

  useEffect(() => {
    if (!room) return;

    const onData = (payload: Uint8Array) => {
      const packet = decodeReaction(payload);
      // Chat packets land here too — decodeReaction rejects anything that is
      // not type 'reaction', exactly as decodeChat rejects everything that is.
      if (!packet) return;
      spawn(packet.emoji);
    };

    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, spawn]);

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

  return { reactions, spawn };
}

/**
 * The overlay itself.
 *
 * aria-hidden and pointer-events-none: this is decoration over a video. A
 * screen reader announcing "หัวใจ" forty times a minute would make the page
 * unusable — the same reason the chat log is not aria-live — and a layer that
 * ate clicks would take the volume button with it.
 */
export function FloatingReactionsLayer({
  reactions,
  className = '',
}: {
  reactions: FloatingReaction[];
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-10 overflow-hidden ${className}`}
    >
      {reactions.map((reaction) => (
        <span
          key={reaction.id}
          className="aurum-reaction"
          style={
            {
              left: `${reaction.leftPct}%`,
              '--reaction-drift': `${reaction.driftPx}px`,
            } as React.CSSProperties
          }
        >
          <span className="aurum-reaction__emoji">{reaction.emoji}</span>
        </span>
      ))}
    </div>
  );
}
