'use client';

/**
 * The rising emoji overlay.
 *
 * A pure renderer, and only that. The list it draws is owned by
 * useLiveChannel, which is also what receives reactions and echoes the local
 * ones — the hook that used to live in this file subscribed to the LiveKit
 * data channel, and viewers no longer have one.
 *
 * All of the animation is CSS (.aurum-reaction in globals.css). React's only
 * job per reaction is to mount a span and, three seconds later, unmount it.
 *
 * aria-hidden and pointer-events-none: this is decoration over a video. A
 * screen reader announcing "หัวใจ" forty times a minute would make the page
 * unusable — the same reason the chat log is not aria-live — and a layer that
 * ate clicks would take the volume button with it.
 */

import type { FloatingReaction } from '@/lib/live/reactions';

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
