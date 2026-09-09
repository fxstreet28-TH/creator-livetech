'use client';

/**
 * The viewer's reaction rail: the emoji palette, as buttons over the player.
 *
 * One arrangement, two placements. The desktop watch layout puts six of them
 * across the bottom-right of the 16:9 player; the full-bleed phone layout puts
 * four in the bottom bar, on the line directly above the message input. See
 * `limit` — everything below it is identical either way.
 *
 * IT USED TO HAVE A VERTICAL MODE, for the phone's right-edge rail. That rail
 * is gone: a column of emoji floating over the middle of the video sat on the
 * thing a viewer came to watch, and Por asked for them down in the message
 * row. The buttons themselves did not change — only where they are mounted.
 *
 * A tap both sends and spawns locally — the Realtime channel is opened with
 * `self: false`, so without the local echo the sender would be the one person
 * who does not see their own heart. Both halves are useLiveChannel's job now;
 * this component only decides WHEN to fire.
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
import {
  LONG_PRESS_DELAY_MS,
  LONG_PRESS_INTERVAL_MS,
  REACTION_OPTIONS,
  createReactionThrottle,
} from '@/lib/live/reactions';

interface EmojiReactionButtonProps {
  /** useLiveChannel's sender. It both broadcasts and echoes locally. */
  onReact: (emoji: string) => void;
  /** False until the channel subscription settles; the buttons stay disabled. */
  enabled: boolean;
  /**
   * How many of REACTION_OPTIONS to render, from the start of the list.
   *
   * The phone's row shares its line with nothing but has to stay clear of the
   * chat bubbles beside it, so it shows the first four (❤️ 🔥 👏 😂) rather
   * than all six. The palette itself is unchanged — a received ⭐ or 💯 still
   * renders — this only limits what THIS rail can send.
   */
  limit?: number;
  className?: string;
}

export function EmojiReactionButton({
  onReact,
  enabled,
  limit,
  className = '',
}: EmojiReactionButtonProps) {
  const options = limit === undefined ? REACTION_OPTIONS : REACTION_OPTIONS.slice(0, limit);
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
      if (!enabled) return;
      // Dropped, not queued: a heart that arrives a second late is not a
      // reaction to anything.
      if (!throttleRef.current()) return;
      onReact(emoji);
    },
    [enabled, onReact],
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
      // Wraps rather than overflowing: six 44px targets plus gaps is wider than
      // a 320px phone, and a rail that runs off the left edge of the video
      // takes the first emoji with it.
      //
      // AGAINST THE VIEWPORT, not the parent. A percentage cap resolves against
      // a container whose own width is content-sized here, which Chrome settles
      // by squeezing the phone's four circles into two columns of two —
      // measured, not feared. 70vw is the same intent expressed as a length
      // that cannot chase its own tail: 273px on a 390px phone, where four
      // 44px circles and their gaps come to 200.
      className={`flex max-w-[70vw] flex-wrap items-center justify-end gap-2 ${className}`}
      role="group"
      aria-label="ส่งอิโมจิให้ผู้ถ่ายทอด"
    >
      {options.map((option) => (
        <button
          key={option.emoji}
          type="button"
          disabled={!enabled}
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
          // 44px: the app's tap-target floor, and four of them plus their
          // gaps is 200px — comfortably inside the space beside the chat
          // column on the narrowest phone this layout supports.
          className={`inline-flex h-11 w-11 select-none items-center justify-center rounded-full border border-white/15 bg-black/40 text-xl leading-none backdrop-blur-md transition hover:scale-110 hover:border-transparent hover:bg-black/55 hover:shadow-[0_0_0_1px_rgba(139,92,246,0.6),0_0_18px_rgba(34,211,238,0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 active:scale-95 disabled:opacity-40 disabled:hover:scale-100 disabled:hover:shadow-none`}
          style={{ touchAction: 'none' }}
        >
          <span aria-hidden>{option.emoji}</span>
        </button>
      ))}
    </div>
  );
}
