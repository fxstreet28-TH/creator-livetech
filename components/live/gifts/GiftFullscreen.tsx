'use client';

/**
 * The centre stage, for tiers whose `display_mode` is 'fullscreen'.
 *
 * One at a time, chosen by useGiftQueue. The tray keeps working underneath —
 * they are separate layers of the same overlay, so a Stardust can still land
 * while a Nova is playing, which is what a busy stream actually looks like.
 *
 * The backdrop is deliberately light (rgba(5,4,22,.45)): this covers the
 * creator's video for up to ten seconds, and a dim that made the broadcast
 * unwatchable would turn the most expensive gift on the board into the most
 * resented one.
 */

import { useState, type CSSProperties } from 'react';
import { rarityStyle, starsFragment, type LiveGiftEvent } from '@/lib/live/gifts';
import { GiftAnimation } from './animations';
import type { FullscreenItem } from './useGiftQueue';
import { STAGE_PX, useStageSize } from './useStageScale';
import styles from './GiftFullscreen.module.css';

export function GiftFullscreen({
  item,
  reduceMotion = false,
}: {
  item: FullscreenItem | null;
  reduceMotion?: boolean;
}) {
  if (!item) return null;
  // Keyed on the queue's item key so a new gift REPLACES the old component
  // rather than re-rendering it with new props — the animations run once with
  // `forwards`, so a reused element would hold the previous gift's last frame.
  return <FullscreenStage key={item.key} event={item.event} reduceMotion={reduceMotion} />;
}

function FullscreenStage({
  event,
  reduceMotion,
}: {
  event: LiveGiftEvent;
  reduceMotion: boolean;
}) {
  const rarity = rarityStyle(event.rarity);
  const stars = starsFragment(event.stars_total);

  /**
   * Set once the arc has played.
   *
   * The queue is what removes this from the screen; `onDone` only fades the
   * caption, so the last moment of an expensive gift is the mascot rather than
   * a block of text. Under reduced motion the whole thing is a 1.5s fade, and
   * the caption is what carries the information — so it does not fade there.
   */
  const [done, setDone] = useState(false);

  // The element is held in state, and the setter IS the ref — see useStageSize
  // for why the measurement is not a callback ref of its own.
  const [stageNode, setStageNode] = useState<HTMLDivElement | null>(null);
  const stageSize = useStageSize(stageNode);

  return (
    <div
      ref={setStageNode}
      className={`${styles.backdrop} ${reduceMotion ? styles.backdropStill : ''}`}
      // Decoration over a video. A screen reader announcing a gift every few
      // seconds would make the page unusable — the same call the chat log and
      // the reaction layer already make.
      aria-hidden
    >
      <div
        className={styles.stageBox}
        style={
          {
            width: stageSize,
            height: stageSize,
            '--rarity-glow': rarity.glow,
          } as CSSProperties
        }
      >
        {/* The stage is authored at 300px and scaled as a unit, so its layers
            keep their relationship to each other at any size. Sized by
            useStageScale — see its header for why this cannot be CSS. */}
        <div
          className={styles.stageInner}
          style={{
            width: STAGE_PX,
            height: STAGE_PX,
            transform: `scale(${stageSize / STAGE_PX})`,
          }}
        >
          <GiftAnimation
            animationKey={event.animation_key}
            durationMs={event.duration_ms}
            reduceMotion={reduceMotion}
            tierId={event.tier_id}
            tint={rarity.glow}
            onDone={() => setDone(true)}
          />
        </div>
      </div>

      <div className={`${styles.caption} ${done && !reduceMotion ? styles.captionOut : ''}`}>
        <p className={styles.sender}>
          {event.sender.display_name} <span className={styles.verb}>ส่ง</span>{' '}
          <span className={rarity.text}>{event.name_en}</span> ×{event.quantity}
        </p>
        {stars !== null && <p className={styles.stars}>{stars}</p>}
        {event.message && <p className={styles.message}>{event.message}</p>}
      </div>
    </div>
  );
}
