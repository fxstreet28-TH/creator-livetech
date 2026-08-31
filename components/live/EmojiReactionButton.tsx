'use client';

/**
 * The viewer's reaction rail: six emoji across the bottom-right of the player.
 *
 * A tap sends one reaction to everyone in the room AND spawns one locally —
 * both, because LiveKit does not echo a participant's own data packets back to
 * them, so the local spawn is the only way the sender sees their own heart.
 *
 * Holding a button repeats at 3/sec. That is under the 10/sec throttle on
 * purpose: a held button should feel generous, and still leave a viewer room
 * to tap a second emoji without either of them being dropped.
 *
 * Only the viewer screen mounts this. A creator does not send reactions to
 * their own broadcast — they receive them (see CreatorBroadcaster, which
 * mounts the overlay and nothing else).
 */

import { useCallback, useEffect, useRef } from 'react';
import { publishReaction, type Room } from '@/lib/live/livekitClient';
import {
  LONG_PRESS_DELAY_MS,
  LONG_PRESS_INTERVAL_MS,
  REACTION_OPTIONS,
  createReactionThrottle,
} from '@/lib/live/reactions';

interface EmojiReactionButtonProps {
  /** Null until the room is connected; the buttons stay disabled until then. */
  room: Room | null;
  /** Local echo — see the header. */
  onSpawn: (emoji: string) => void;
  className?: string;
}

export function EmojiReactionButton({ room, onSpawn, className = '' }: EmojiReactionButtonProps) {
  // One throttle for the whole rail, not one per button: the limit is per
  // participant, and six buttons with their own allowance would be six times
  // the limit.
  const throttleRef = useRef(createReactionThrottle());
  const holdRef = useRef<{ delay?: ReturnType<typeof setTimeout>; repeat?: ReturnType<typeof setInterval> }>({});

  const stopHold = useCallback(() => {
    if (holdRef.current.delay) clearTimeout(holdRef.current.delay);
    if (holdRef.current.repeat) clearInterval(holdRef.current.repeat);
    holdRef.current = {};
  }, []);

  // A pointer released outside the button never fires pointerup on it, and a
  // repeat that outlives the component would publish into a closed room.
  useEffect(() => stopHold, [stopHold]);

  const fire = useCallback(
    (emoji: string) => {
      if (!room) return;
      // Dropped, not queued: a heart that arrives a second late is not a
      // reaction to anything.
      if (!throttleRef.current()) return;

      onSpawn(emoji);
      void publishReaction(room, emoji).catch((err) => {
        // Silent by design. The local emoji has already flown, and there is no
        // toast system in this repo (nor is one in scope) — a failed packet
        // costs the other participants one heart, not this viewer their tap.
        console.error('[EmojiReactionButton] publishReaction failed', err);
      });
    },
    [room, onSpawn],
  );

  const startHold = useCallback(
    (emoji: string) => {
      stopHold();
      holdRef.current.delay = setTimeout(() => {
        holdRef.current.repeat = setInterval(() => fire(emoji), LONG_PRESS_INTERVAL_MS);
      }, LONG_PRESS_DELAY_MS);
    },
    [fire, stopHold],
  );

  return (
    <div
      // Wraps rather than overflowing: six 44px targets plus gaps is wider
      // than a 320px phone, and a rail that runs off the left edge of the
      // video takes the first emoji with it.
      className={`flex max-w-[70%] flex-wrap items-center justify-end gap-2 ${className}`}
      role="group"
      aria-label="ส่งอิโมจิให้ผู้ถ่ายทอด"
    >
      {REACTION_OPTIONS.map((option) => (
        <button
          key={option.emoji}
          type="button"
          disabled={!room}
          aria-label={option.label}
          title={option.label}
          // pointerdown rather than click: a tap has to register on the way
          // down for the rail to feel like a game controller, and the same
          // event is what starts the long-press repeat. Keyboard users get
          // onKeyDown below — there is no onClick to double-fire against.
          onPointerDown={(event) => {
            // Ignore the secondary buttons of a mouse; a right-click is a
            // context menu, not a heart.
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            fire(option.emoji);
            startHold(option.emoji);
          }}
          onPointerUp={stopHold}
          onPointerCancel={stopHold}
          onPointerLeave={stopHold}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            // Space would scroll the page, and both keys would synthesise a
            // click we are not listening for anyway.
            event.preventDefault();
            // A held key repeats at the OS rate, which is faster than 3/sec
            // on most machines — the throttle is what paces that one.
            fire(option.emoji);
          }}
          // A long press on iOS otherwise raises the copy/lookup menu over the
          // video, which ends the hold and looks like a bug.
          onContextMenu={(event) => event.preventDefault()}
          className="inline-flex h-11 w-11 select-none items-center justify-center rounded-full border border-white/15 bg-black/40 text-xl leading-none backdrop-blur-md transition hover:scale-110 hover:border-transparent hover:bg-black/55 hover:shadow-[0_0_0_1px_rgba(139,92,246,0.6),0_0_18px_rgba(34,211,238,0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 active:scale-95 disabled:opacity-40 disabled:hover:scale-100 disabled:hover:shadow-none"
          style={{ touchAction: 'none' }}
        >
          <span aria-hidden>{option.emoji}</span>
        </button>
      ))}
    </div>
  );
}
