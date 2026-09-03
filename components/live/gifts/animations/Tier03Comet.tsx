'use client';

/**
 * Tier 03 — Comet. น้อง Aurum streaks in from the left, brakes into the centre,
 * and the impact throws a ring and a scatter of gold.
 *
 * The flight and the body are separate transforms on nested elements on
 * purpose: composing "travelling across the screen" and "tumbling and landing"
 * into one transform means every keyframe has to restate both, and the two
 * cannot then be eased differently — the flight wants a hard decelerate, the
 * body wants an overshoot.
 */

import { sparkleRing, sparkleStyle, stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './Tier03Comet.module.css';

const SPARKLES = sparkleRing(18, 62);

export function Tier03Comet({
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
      <span className={styles.glow} />
      <span className={styles.ring} />
      <span className={`${styles.ring} ${styles.ringLate}`} />

      {!reduceMotion &&
        SPARKLES.map((sparkle, i) => (
          <span key={i} className={styles.sparkle} style={sparkleStyle(sparkle)} />
        ))}

      <div className={styles.flight}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/gifts/tier-03/tail.png" alt="" className={`${styles.layer} ${styles.tail}`} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/gifts/tier-03/body.png" alt="" className={`${styles.layer} ${styles.body}`} />
      </div>
    </div>
  );
}
