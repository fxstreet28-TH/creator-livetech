'use client';

/**
 * Tier 01 — Stardust. น้อง Aurum pops up and waves, trailing cyan dust.
 *
 * Two PNG layers (body, arm) over a radial glow, plus twelve particles whose
 * positions come from `sparkleRing` rather than from `Math.random()` — the same
 * markup has to be produced on the server and on the client, and a random
 * scatter hydrates with a mismatch on every gift.
 *
 * See ./types.ts for why every layer is keyed off one `--cycle`.
 */

import { sparkleRing, sparkleStyle, stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './Tier01Stardust.module.css';

const SPARKLES = sparkleRing(12, 44);

export function Tier01Stardust({
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

      {!reduceMotion &&
        SPARKLES.map((sparkle, i) => (
          <span key={i} className={styles.sparkle} style={sparkleStyle(sparkle)} />
        ))}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/gifts/tier-01/body.png" alt="" className={`${styles.layer} ${styles.body}`} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/gifts/tier-01/arm.png" alt="" className={`${styles.layer} ${styles.arm}`} />
    </div>
  );
}
