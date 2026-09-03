'use client';

/**
 * Tier 04 — Nova. The board's most expensive animation: a charge, a burst, and
 * then a long hold.
 *
 * The hold is the feature. A ten-second gift that is ten seconds of explosion
 * is exhausting and unreadable; a burst followed by five seconds of the mascot
 * simply being there is what gives the creator time to read the sender's name
 * and say it out loud, which is what the sender paid for.
 */

import { sparkleRing, sparkleStyle, stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './Tier04Nova.module.css';

const SPARKLES = sparkleRing(24, 74);

export function Tier04Nova({
  durationMs,
  onDone,
  reduceMotion = false,
  className = '',
}: GiftAnimationProps) {
  useAnimationDone(durationMs, onDone);

  return (
    <div
      aria-hidden
      className={`${styles.stage} ${reduceMotion ? styles.still : ''} ${className}`}
      style={stageStyle(durationMs)}
    >
      <span className={styles.inward} />
      <span className={`${styles.inward} ${styles.inwardLate}`} />
      <span className={styles.rays} />
      <span className={styles.core} />
      <span className={styles.halo} />

      {!reduceMotion &&
        SPARKLES.map((sparkle, i) => (
          <span key={i} className={styles.sparkle} style={sparkleStyle(sparkle)} />
        ))}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/gifts/tier-04/body.png" alt="" className={`${styles.layer} ${styles.body}`} />

      <span className={styles.ring} />
      <span className={`${styles.ring} ${styles.ringLate}`} />
      <span className={styles.flash} />
    </div>
  );
}
