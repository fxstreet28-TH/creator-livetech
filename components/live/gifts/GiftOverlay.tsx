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

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useReducedMotion } from 'framer-motion';
import type { LiveGiftEvent } from '@/lib/live/gifts';
import { GiftFullscreen } from './GiftFullscreen';
import { GiftTray } from './GiftTray';
import { useGiftQueue } from './useGiftQueue';
import { giftLayout, useElementBox, useIsDesktop, type GiftAnchor } from './useStageScale';
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
  /**
   * Explicit anchored geometry, overriding the percentages derived from the
   * player's size.
   *
   * For a surface that knows its own canvas: the OBS source composites onto a
   * 1920 × 1080 scene, and the numbers there were chosen against that scene
   * rather than derived from a fraction of it. Everything else omits it.
   */
  anchor?: GiftAnchor;
  className?: string;
}

export function GiftOverlay({
  latestGift,
  resetKey = null,
  inset,
  anchor,
  className = '',
}: GiftOverlayProps) {
  const { trayItems, fullscreenItem, enqueue, clear } = useGiftQueue();

  /**
   * The ONE measurement of the player, and everything geometric derives from
   * it.
   *
   * The element is held in state and the setter IS the ref — see
   * useStageScale.ts for why the measurement is not a callback ref of its own.
   * Measuring here rather than inside GiftFullscreen matters because the TRAY
   * needs the answer too: on a desktop player the stage moves into the corner
   * the tray already occupies, and the two have to agree about where that is.
   */
  const [rootNode, setRootNode] = useState<HTMLDivElement | null>(null);
  const box = useElementBox(rootNode);
  const desktop = useIsDesktop();
  const layout = useMemo(() => giftLayout(box, desktop, anchor), [box, desktop, anchor]);

  /**
   * How wide the stage is actually drawing, reported by GiftFullscreen.
   *
   * A CSS tier is square, but a video card is as wide as its clip — 1.5× the
   * stage height for a 720 × 476 one — and the tray has to step past whichever
   * it is. A constant sized for the widest clip anyone might add would leave
   * the tray stranded in the middle of the player for every other gift.
   */
  const [stageWidth, setStageWidth] = useState(0);
  const handleStageWidth = useCallback((width: number) => setStageWidth(width), []);

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

  /**
   * The tray steps aside only when it would otherwise be underneath.
   *
   * Anchored mode puts the stage in the bottom-left corner, which is the tray's
   * corner. Centred mode does not, so the tray stays where it is — and it stays
   * put when no fullscreen gift is playing, which is most of the time.
   */
  const trayShifted = layout.anchored && fullscreenItem !== null;

  return (
    <div
      ref={setRootNode}
      aria-hidden
      className={`${styles.overlay} ${className}`}
      style={
        {
          ...(inset === undefined ? null : { '--gift-inset': `${inset}px` }),
          '--gift-anchor-left': layout.left,
          '--gift-stage-width': `${Math.round(stageWidth)}px`,
        } as CSSProperties
      }
    >
      <GiftFullscreen
        item={fullscreenItem}
        layout={layout}
        reduceMotion={reduceMotion}
        onWidthChange={handleStageWidth}
      />
      <GiftTray items={trayItems} reduceMotion={reduceMotion} shifted={trayShifted} />
    </div>
  );
}
