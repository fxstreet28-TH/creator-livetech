'use client';

/**
 * The gift overlay: one element, mounted over a video, that plays every gift
 * sent to the session.
 *
 * The same component on all three screens — the creator's studio, the viewer's
 * watch page, and the OBS browser source — so what the creator sees is what
 * their audience sees, frame for frame. Any of the three drifting from the
 * others is a support ticket nobody can reproduce.
 *
 * IT DOES NOT OWN THE CHANNEL.
 *
 * Events are handed in. The session's Realtime channel is opened exactly once
 * per screen by useLiveChannel — it carries chat, reactions, presence and gifts
 * together, and a second subscription here would mean a second presence entry
 * and a viewer count that counts everyone twice. So this takes an
 * `onRegister`-style prop rather than reaching for the transport itself.
 *
 * The whole layer is `pointer-events: none` and `aria-hidden`. It is decoration
 * over someone else's video: it must not eat a tap meant for the play button,
 * and a screen reader announcing a gift every few seconds would make the page
 * unusable — the same call the chat log and the reaction layer already make.
 */

import { useEffect, type CSSProperties } from 'react';
import { useReducedMotion } from 'framer-motion';
import type { LiveGiftEvent } from '@/lib/live/gifts';
import { GiftFullscreen } from './GiftFullscreen';
import { GiftTray } from './GiftTray';
import { useGiftQueue } from './useGiftQueue';
import styles from './GiftOverlay.module.css';

export interface GiftOverlayProps {
  /**
   * The most recent gift, or null.
   *
   * A single event rather than an array, because the queue is what accumulates
   * — handing it a list would mean the caller kept its own copy of the backlog
   * and the two could disagree about what had already played. Re-sending the
   * same event is harmless: the queue de-duplicates on `gift_id`.
   */
  latestGift: LiveGiftEvent | null;
  /**
   * Changes when the overlay should forget what is on screen — a new session,
   * a re-mount. `seen` ids are deliberately kept across a clear (see
   * useGiftQueue), because a reconnect is exactly when a replay arrives.
   */
  resetKey?: string | null;
  /**
   * Tray inset from the bottom-left corner, in px.
   *
   * Passed down as a custom property rather than as padding on this element:
   * the tray is absolutely positioned inside it, so padding here would not move
   * it. Raised on the OBS overlay, where 1080p needs a real safe area.
   */
  inset?: number;
  className?: string;
}

export function GiftOverlay({
  latestGift,
  resetKey = null,
  inset,
  className = '',
}: GiftOverlayProps) {
  const { trayItems, fullscreenItem, enqueue, clear } = useGiftQueue();

  /**
   * `prefers-reduced-motion`, via framer-motion's hook because the repo already
   * depends on it and EndLiveConfirm already reads it this way.
   *
   * It returns null before it has resolved; treated as false, so the first
   * gift on a first paint animates. Getting that wrong in the other direction
   * would show every viewer a static gift for the first second of the page.
   */
  const reduceMotion = useReducedMotion() === true;

  useEffect(() => {
    if (latestGift) enqueue(latestGift);
  }, [latestGift, enqueue]);

  useEffect(() => {
    clear();
  }, [resetKey, clear]);

  return (
    <div
      aria-hidden
      className={`${styles.overlay} ${className}`}
      style={inset === undefined ? undefined : ({ '--gift-inset': `${inset}px` } as CSSProperties)}
    >
      <GiftFullscreen item={fullscreenItem} reduceMotion={reduceMotion} />
      <GiftTray items={trayItems} reduceMotion={reduceMotion} />
    </div>
  );
}
