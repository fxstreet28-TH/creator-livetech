'use client';

/**
 * The stage for tiers whose `display_mode` is 'fullscreen'.
 *
 * One at a time, chosen by useGiftQueue. The tray keeps working underneath —
 * they are separate layers of the same overlay, so a Stardust can still land
 * while a Nova is playing, which is what a busy stream actually looks like.
 *
 * WHERE IT SITS IS A LAYOUT DECISION, NOT THIS FILE'S
 *
 * `layout` arrives from GiftOverlay, which owns the one measurement of the
 * player. In the stacked layouts the stage is centred behind a dim; anchored,
 * it sits on the player's bottom-left corner with its caption above it and a
 * glow that stops at its own edge, so the creator's face stays visible for the
 * forty seconds a tier-07 clip runs. See useStageScale.ts for how that is
 * decided, and for why the phone layout keeps its caption underneath.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { rarityStyle, starsFragment, type LiveGiftEvent } from '@/lib/live/gifts';
import { GiftAnimation } from './animations';
import type { FullscreenItem } from './useGiftQueue';
import { STAGE_PX, useElementBox, type GiftLayout } from './useStageScale';
import styles from './GiftFullscreen.module.css';

export function GiftFullscreen({
  item,
  layout,
  reduceMotion = false,
  onWidthChange,
}: {
  item: FullscreenItem | null;
  layout: GiftLayout;
  reduceMotion?: boolean;
  /**
   * The stage's rendered width, reported upward so the tray can step aside.
   *
   * A CSS tier is square and its width is `layout.stagePx`, but a video card is
   * as wide as its clip's aspect ratio makes it — which nothing knows until the
   * poster has laid out. The tray needs the real number to sit beside it rather
   * than a constant guessed from the widest clip anyone might add later.
   */
  onWidthChange?: (width: number) => void;
}) {
  if (!item) return null;
  // Keyed on the queue's item key so a new gift REPLACES the old component
  // rather than re-rendering it with new props — the animations run once with
  // `forwards`, so a reused element would hold the previous gift's last frame.
  return (
    <FullscreenStage
      key={item.key}
      event={item.event}
      layout={layout}
      reduceMotion={reduceMotion}
      onWidthChange={onWidthChange}
    />
  );
}

function FullscreenStage({
  event,
  layout,
  reduceMotion,
  onWidthChange,
}: {
  event: LiveGiftEvent;
  layout: GiftLayout;
  reduceMotion: boolean;
  onWidthChange?: (width: number) => void;
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

  /**
   * The stage's UNSCALED width, measured from the element.
   *
   * `transform: scale()` deliberately does not affect layout, so what is
   * observed here is the authored 300 for a CSS tier and the clip's own
   * 300 × (w / h) for a video card; multiplying by the scale gives the
   * footprint the box has to reserve.
   *
   * Observed rather than read once on mount, because a video card has no width
   * until its poster has loaded — on a cold cache that is several frames after
   * the element exists, and a one-shot measurement would have latched the
   * empty box.
   */
  const [stageNode, setStageNode] = useState<HTMLDivElement | null>(null);
  const stageBox = useElementBox(stageNode);
  const naturalWidth = stageBox.width || STAGE_PX;

  /**
   * The scale, from the height the layout asked for — and, where the layout
   * states one, capped so the RESULT is no wider than `maxWidthPx`.
   *
   * A CSS tier is square, so the cap never binds on one: at a 200px stage its
   * natural width is the authored 300 and 200/300 is already the smaller
   * factor. A video card is the case this exists for — a 720 × 476 clip is
   * 1.5× as wide as it is tall, so drawn at a 200px HEIGHT it is 302px wide,
   * which on a phone is most of the screen and lands on the chat column. With
   * the cap it is drawn 200px wide and 132px tall instead, and both kinds of
   * gift occupy the same strip.
   */
  const scale = Math.min(
    layout.stagePx / STAGE_PX,
    layout.maxWidthPx === undefined ? Infinity : layout.maxWidthPx / naturalWidth,
  );
  const renderedWidth = naturalWidth * scale;

  useEffect(() => {
    onWidthChange?.(renderedWidth);
  }, [renderedWidth, onWidthChange]);

  return (
    <div
      className={`${layout.anchored ? styles.anchor : styles.backdrop} ${
        layout.captionAbove ? styles.captionAbove : ''
      } ${reduceMotion ? styles.still : ''}`}
      style={
        {
          '--gift-anchor-left': layout.left,
          '--gift-anchor-bottom': layout.bottom,
          '--rarity-glow': rarity.glow,
        } as CSSProperties
      }
      // Decoration over a video. A screen reader announcing a gift every few
      // seconds would make the page unusable — the same call the chat log and
      // the reaction layer already make.
      aria-hidden
    >
      <div
        className={styles.stageBox}
        // The height follows the SAME scale rather than being `layout.stagePx`
        // outright, so a stage the width cap shrank does not leave an empty
        // band under it.
        style={{ width: renderedWidth, height: STAGE_PX * scale }}
      >
        {/* Authored at 300px and scaled as a unit, so the layers keep their
            relationship to each other at any size — see useStageScale.ts for
            why the factor cannot be computed in CSS. The origin is `top left`
            so the scaled result fills the box it was measured into, rather than
            spilling out of it in every direction. */}
        <div
          ref={setStageNode}
          className={styles.stageInner}
          style={{ height: STAGE_PX, transform: `scale(${scale})` }}
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
