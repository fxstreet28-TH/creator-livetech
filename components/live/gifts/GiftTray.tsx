'use client';

/**
 * The stack of gift rows down the left of the video.
 *
 * A pure renderer. Which rows exist, what their ×N is and when they leave is
 * entirely useGiftQueue's business — this file knows only how a row looks.
 * That split is why the timing rules are testable without a DOM.
 *
 * Newest on top, at most three, `pointer-events: none` throughout: this is
 * painted over a video player and must never take a tap meant for the play
 * button or the chat input under it.
 */

import { rarityStyle, starsFragment, type LiveGiftEvent } from '@/lib/live/gifts';
import { GiftAnimation } from './animations';
import type { TrayItem } from './useGiftQueue';
import styles from './GiftTray.module.css';

/**
 * How much of the 300 × 300 stage a tray row shows.
 *
 * Scaled with a transform rather than by rendering the stage smaller: the
 * animations position their layers in stage pixels, so shrinking the box would
 * need every keyframe re-expressed in percentages of an unknown size. The
 * wrapper below is sized to the scaled result so the transform does not leave a
 * 300px hole in the layout.
 */
const MINI_SCALE = 0.35;
const MINI_BOX = Math.round(300 * MINI_SCALE);

export function GiftTray({
  items,
  reduceMotion = false,
  className = '',
}: {
  items: TrayItem[];
  reduceMotion?: boolean;
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div className={`${styles.tray} ${className}`}>
      {items.map((item) => (
        <GiftTrayRow key={item.key} item={item} reduceMotion={reduceMotion} />
      ))}
    </div>
  );
}

function GiftTrayRow({ item, reduceMotion }: { item: TrayItem; reduceMotion: boolean }) {
  const { event } = item;
  const rarity = rarityStyle(event.rarity);
  const stars = starsFragment(item.starsTotal);

  return (
    <div className={`${styles.row} ${rarity.surface} ${reduceMotion ? styles.rowStill : ''}`}>
      <div className={styles.mini} style={{ width: MINI_BOX, height: MINI_BOX }}>
        <div className={styles.miniInner} style={{ transform: `scale(${MINI_SCALE})` }}>
          <GiftAnimation
            animationKey={event.animation_key}
            // Keyed on the bump count so a combo REPLAYS the animation: the
            // tenth tap should look like something happened, and a component
            // that stays mounted just holds its finished last frame.
            key={item.bumpSeq}
            durationMs={event.duration_ms}
            reduceMotion={reduceMotion}
            tierId={event.tier_id}
            tint={rarity.glow}
          />
        </div>
      </div>

      <div className={styles.text}>
        <p className={styles.sender}>{event.sender.display_name}</p>
        <p className={styles.line}>
          ส่ง <span className={rarity.text}>{event.name_th}</span>
          <span key={item.bumpSeq} className={styles.count}>
            ×{item.count}
          </span>
        </p>
        {/* Absent, not zero: a free gift showing "+0 ⭐" reads as one that
            failed to charge rather than one that was free by design. */}
        {stars !== null && <p className={styles.stars}>{stars}</p>}
        {event.message && <p className={styles.message}>{event.message}</p>}
      </div>
    </div>
  );
}

/** Exported for the dev harness, which builds fake events. */
export type { LiveGiftEvent };
