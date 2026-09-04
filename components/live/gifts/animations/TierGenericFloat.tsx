'use client';

/**
 * The fallback animation, and the safety net.
 *
 * Nothing in the seeded catalogue renders this any more — all seven tiers have
 * their own key. It exists for the tier that does NOT: an `animation_key` the
 * registry has never heard of, because the CEO added a row before the component
 * for it shipped, or repointed an existing one. That is a normal condition with
 * a defined outcome rather than an error, and the outcome is that a gift
 * somebody paid 3,000 stars for animates instead of showing an empty box.
 *
 * The mascot path is built from the tier id and clamped to the ids that have a
 * `body.png`. Tiers 05-07 no longer do — they are video, and their folders hold
 * a clip and a poster — so an unknown key on one of those, or on any id outside
 * the range, falls back to tier 01's body rather than requesting a 404. A
 * broken-image icon on top of a live broadcast is worse than the wrong mascot.
 */

import type { CSSProperties } from 'react';
import { sparkleRing, sparkleStyle, stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './TierGenericFloat.module.css';

const SPARKLES = sparkleRing(12, 48);

/** Tiers with a body.png committed. See public/gifts/README.md. */
const MIN_TIER_WITH_ART = 1;
const MAX_TIER_WITH_ART = 4;

function bodySrc(tierId: number | undefined): string {
  const id =
    typeof tierId === 'number' && tierId >= MIN_TIER_WITH_ART && tierId <= MAX_TIER_WITH_ART
      ? tierId
      : MIN_TIER_WITH_ART;
  return `/gifts/tier-${String(id).padStart(2, '0')}/body.png`;
}

export function TierGenericFloat({
  durationMs,
  onDone,
  reduceMotion = false,
  tierId,
  tint = '#ffffff',
  className = '',
}: GiftAnimationProps) {
  useAnimationDone(durationMs, onDone);

  return (
    <div
      aria-hidden
      className={`${styles.stage} ${reduceMotion ? styles.still : ''} ${className}`}
      style={stageStyle(durationMs, { '--tint': tint } as CSSProperties)}
    >
      <span className={styles.glow} />

      {!reduceMotion &&
        SPARKLES.map((sparkle, i) => (
          <span key={i} className={styles.sparkle} style={sparkleStyle(sparkle)} />
        ))}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={bodySrc(tierId)} alt="" className={`${styles.layer} ${styles.body}`} />

      <span className={styles.antenna} />
    </div>
  );
}
