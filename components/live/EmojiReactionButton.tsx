'use client';

/**
 * The viewer's reaction rail: the emoji palette, as buttons over the player.
 *
 * Two arrangements of the same buttons. The desktop watch layout puts six of
 * them across the bottom-right of the 16:9 player; the full-bleed phone layout
 * runs four plus a share button down the right edge, above the gift stage. See
 * `orientation` and `limit` — everything below them is identical either way.
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
   * A column instead of a wrapped row.
   *
   * The full-bleed phone layout runs the rail down the right edge, TikTok
   * style, where the bottom of the screen belongs to the chat and the input
   * row. Nothing else about the buttons changes — same handler, same throttle,
   * same long-press repeat — because the point of the phone re-layout was to
   * MOVE these controls, not to grow a second copy of them.
   */
  orientation?: 'horizontal' | 'vertical';
  /**
   * How many of REACTION_OPTIONS to render, from the start of the list.
   *
   * The vertical rail shares its column with a share button and has to end
   * above the gift stage, so it shows the first four (❤️ 🔥 👏 😂) rather than
   * all six. The palette itself is unchanged — a received ⭐ or 💯 still
   * renders — this only limits what THIS rail can send.
   */
  limit?: number;
  /** 30px circles instead of 40, for the landscape rail. See RailButton. */
  compact?: boolean;
  className?: string;
}

export function EmojiReactionButton({
  onReact,
  enabled,
  orientation = 'horizontal',
  limit,
  compact = false,
  className = '',
}: EmojiReactionButtonProps) {
  const vertical = orientation === 'vertical';
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
      // Horizontal wraps rather than overflowing: six 44px targets plus gaps is
      // wider than a 320px phone, and a rail that runs off the left edge of the
      // video takes the first emoji with it. Vertical has a column to itself
      // and does not need to.
      className={`flex items-center gap-2 ${
        vertical ? (compact ? 'flex-col gap-1.5' : 'flex-col gap-2.5') : 'max-w-[70%] flex-wrap justify-end'
      } ${className}`}
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
          className={`inline-flex select-none items-center justify-center rounded-full border border-white/15 bg-black/40 leading-none backdrop-blur-md transition hover:scale-110 hover:border-transparent hover:bg-black/55 hover:shadow-[0_0_0_1px_rgba(139,92,246,0.6),0_0_18px_rgba(34,211,238,0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 active:scale-95 disabled:opacity-40 disabled:hover:scale-100 disabled:hover:shadow-none ${
            // 40px in the vertical rail: the design's size. 30 when the rail
            // is compact, which is a phone on its side — six 40px circles do
            // not fit in a 375px viewport that also has a bar and a composer.
            // 44 elsewhere, the app's tap-target floor.
            vertical ? (compact ? 'h-[30px] w-[30px] text-sm' : 'h-10 w-10 text-lg') : 'h-11 w-11 text-xl'
          }`}
          style={{ touchAction: 'none' }}
        >
          <span aria-hidden>{option.emoji}</span>
        </button>
      ))}
    </div>
  );
}
