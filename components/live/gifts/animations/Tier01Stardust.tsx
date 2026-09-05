'use client';

/**
 * Tier 01 — Stardust. น้อง Aurum rises into frame, goes "!", waves, and says
 * hello in a puff of sparks.
 *
 * A 1:1 port of `docs/gift-cards/aurum-live-tier01-stardust.html`: same layer
 * names, same CSS variables, same keyframes. The reference card's own script
 * built the sparkle vectors at load time from an index; here that arithmetic is
 * a module constant, which is the same numbers computed once instead of on
 * every gift — and, unlike `Math.random()`, it produces identical markup on the
 * server and the client, so a gift does not hydrate with a mismatch.
 *
 * See ./types.ts for why every layer is keyed off one `--cycle`.
 */

import type { CSSProperties } from 'react';
import { stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './Tier01Stardust.module.css';

/** The reference's four-point star, inlined so nothing is fetched mid-gift. */
function StarSvg() {
  return (
    <svg viewBox="0 0 24 24">
      <path fill="currentColor" d="M12 0l2.6 8.6L24 12l-9.4 3.4L12 24l-2.6-8.6L0 12l9.4-3.4z" />
    </svg>
  );
}

/**
 * The eight sparkle vectors, straight out of the reference card's script:
 *
 *   const a = (i / all.length) * Math.PI * 2 + (i % 2 ? .3 : 0);
 *   const d = 105 + (i % 3) * 22;
 *
 * The `i % 2` nudge is what stops eight evenly spaced points from reading as a
 * clock face; the `i % 3` distance is what stops them landing on one circle.
 */
const SPARK_COUNT = 8;

const SPARKS: CSSProperties[] = Array.from({ length: SPARK_COUNT }, (_, i) => {
  const a = (i / SPARK_COUNT) * Math.PI * 2 + (i % 2 ? 0.3 : 0);
  const d = 105 + (i % 3) * 22;
  return {
    '--tx': `${Math.cos(a) * d}px`,
    '--ty': `${Math.sin(a) * d}px`,
  } as CSSProperties;
});

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
      <div className={styles.mascotWrap}>
        {/* Two layers of one character in the same 300 × 300 frame: the body,
            and the right arm that rotates about the shoulder to wave. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/gifts/tier-01/body.png" alt="" className={styles.mascot} draggable={false} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/gifts/tier-01/arm.png"
          alt=""
          className={`${styles.mascot} ${styles.mascotArm}`}
          draggable={false}
        />

        <div className={`${styles.fx} ${styles.fxAntenna}`} />
        <div className={`${styles.fx} ${styles.fxMouth}`} />
        <div className={`${styles.fx} ${styles.fxBang}`}>!</div>
        <div className={`${styles.fx} ${styles.fxBubble}`}>สวัสดี!</div>

        {SPARKS.map((style, i) => (
          <div
            key={i}
            className={`${styles.fx} ${styles.fxSpark} ${i % 2 ? styles.fxSparkAlt : ''}`}
            style={style}
          >
            <StarSvg />
          </div>
        ))}
      </div>
    </div>
  );
}
