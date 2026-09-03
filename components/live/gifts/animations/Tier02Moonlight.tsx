'use client';

/**
 * Tier 02 — Moonlight. A moon rises behind น้อง Aurum, rays sweep out, and the
 * mascot blinks twice while the light crosses its face.
 *
 * The moon and the rays are CSS gradients rather than PNGs: they are a circle
 * and a conic sweep, they have to tint with the rarity, and two more image
 * requests during a live broadcast on a phone is a worse trade than two more
 * gradients.
 */

import { sparkleRing, sparkleStyle, stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './Tier02Moonlight.module.css';

const SPARKLES = sparkleRing(14, 52);

export function Tier02Moonlight({
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
      <span className={styles.rays} />
      <span className={styles.moon} />

      {!reduceMotion &&
        SPARKLES.map((sparkle, i) => (
          <span key={i} className={styles.sparkle} style={sparkleStyle(sparkle)} />
        ))}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/gifts/tier-02/body.png" alt="" className={`${styles.layer} ${styles.body}`} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/gifts/tier-02/eyelid.png" alt="" className={`${styles.layer} ${styles.eyelid}`} />
    </div>
  );
}
