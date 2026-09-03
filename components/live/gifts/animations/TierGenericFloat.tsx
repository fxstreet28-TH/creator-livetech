'use client';

/**
 * The fallback animation, and the safety net.
 *
 * Tiers 05-07 have mascot art but no name and no reference animation yet, so
 * all three render this. So does any tier whose `animation_key` the registry
 * does not recognise — which is what makes adding a tier to `gift_tiers` safe
 * between deploys: a gift somebody paid 3,000 stars for animates, rather than
 * showing an empty box because the component for its key has not shipped.
 *
 * The mascot path is built from the tier id and clamped to the range that has
 * art. An id outside it falls back to tier 01's body rather than requesting a
 * 404 — a broken image icon on top of a live broadcast is worse than the wrong
 * colour of star.
 */

import type { CSSProperties } from 'react';
import { sparkleRing, sparkleStyle, stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './TierGenericFloat.module.css';

const SPARKLES = sparkleRing(12, 48);

/** Tiers with a body.png committed. See public/gifts/README.md. */
const MIN_TIER_WITH_ART = 1;
const MAX_TIER_WITH_ART = 7;

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
