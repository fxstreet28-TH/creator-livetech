'use client';

/**
 * One circle in the reaction rail that is not a reaction.
 *
 * Share, the fit toggle and the fullscreen control are all the same shape as
 * the emoji buttons beside them and have to stay that way — a rail of five
 * matching circles with two odd ones on the end reads as two rails. The emoji
 * buttons keep their own component because they carry the throttle and the
 * long-press repeat; this is only the dress they share.
 *
 * `compact` is landscape: 30px instead of 40. Six 40px circles and their gaps
 * are 290px of a 375px-tall viewport, which does not leave room for a top bar
 * and a composer.
 */

import type { ReactNode } from 'react';

export function RailButton({
  label,
  onClick,
  compact = false,
  active = false,
  children,
}: {
  /** Both the accessible name and the tooltip; the rail carries no visible text. */
  label: string;
  onClick: () => void;
  compact?: boolean;
  /** Tints the circle, for a control that is a toggle rather than an action. */
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`inline-flex select-none items-center justify-center rounded-full border backdrop-blur-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 active:scale-95 ${
        compact ? 'h-[30px] w-[30px]' : 'h-10 w-10'
      } ${
        active
          ? 'border-cyan-300/60 bg-cyan-400/25 text-white'
          : 'border-white/15 bg-black/40 text-white hover:bg-black/55'
      }`}
    >
      {children}
    </button>
  );
}
