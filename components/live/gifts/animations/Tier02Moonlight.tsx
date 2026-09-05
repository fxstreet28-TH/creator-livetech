'use client';

/**
 * Tier 02 — Moonlight. น้อง Aurum turns a full pirouette under a moon, lands,
 * and winks.
 *
 * A 1:1 port of `docs/gift-cards/aurum-live-tier02-moonlight.html`. The wink is
 * the reason this tier needs two layers: `eyelid.png` is a 27 px patch of the
 * mascot's own skin, dropped over the right eye with `steps(1, end)` so it
 * snaps rather than fades. An eyelid that cross-faded would read as a blur, not
 * a blink.
 *
 * The glitter field and the sparkle burst were built by the reference card's
 * script; both are index arithmetic, so they are module constants here — the
 * same numbers, computed once, and identical on the server and the client.
 */

import type { CSSProperties } from 'react';
import { stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './Tier02Moonlight.module.css';

function StarSvg() {
  return (
    <svg viewBox="0 0 24 24">
      <path fill="currentColor" d="M12 0l2.6 8.6L24 12l-9.4 3.4L12 24l-2.6-8.6L0 12l9.4-3.4z" />
    </svg>
  );
}

/** The reference's sixteen hand-placed glitter positions, in stage percent. */
const GLITTER_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [12, 18], [26, 8], [44, 5], [64, 7], [82, 14], [92, 30], [95, 52], [90, 72],
  [80, 88], [60, 94], [38, 95], [18, 86], [6, 66], [4, 44], [30, 30], [74, 34],
];

/**
 * Size, period and delay per star, from the card's script:
 *
 *   --s: 8 + (i*7)%12 px   --t: 2 + (i*.37)%1.8 s   --d: -(i*.53)%2.4 s
 *
 * The negative delay is what starts each star mid-twinkle, so the field is
 * already alive on the first frame instead of all sixteen lighting up together.
 */
const GLITTER: CSSProperties[] = GLITTER_SPOTS.map(([x, y], i) => ({
  '--x': `${x}%`,
  '--y': `${y}%`,
  '--s': `${8 + ((i * 7) % 12)}px`,
  '--t': `${2 + ((i * 0.37) % 1.8)}s`,
  '--d': `-${(i * 0.53) % 2.4}s`,
}) as CSSProperties);

/**
 * The eight sparks that burst from the winking eye:
 *
 *   const a = (i / all.length) * Math.PI * 2 - .4, d = 95 + (i % 3) * 22;
 *
 * `left` and `top` are set per-element in the reference too — the burst
 * originates at the eye, which is a CSS variable, not a fixed point.
 */
const BURST_COUNT = 8;

const BURSTS: CSSProperties[] = Array.from({ length: BURST_COUNT }, (_, i) => {
  const a = (i / BURST_COUNT) * Math.PI * 2 - 0.4;
  const d = 95 + (i % 3) * 22;
  return {
    left: 'calc(var(--eye-x) + 8px)',
    top: 'var(--eye-y)',
    '--tx': `${Math.cos(a) * d}px`,
    '--ty': `${Math.sin(a) * d}px`,
  } as CSSProperties;
});

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
      <div className={styles.moon} />

      <div className={styles.glitter}>
        {GLITTER.map((style, i) => (
          <svg key={i} viewBox="0 0 24 24" style={style}>
            <path fill="currentColor" d="M12 0l2.6 8.6L24 12l-9.4 3.4L12 24l-2.6-8.6L0 12l9.4-3.4z" />
          </svg>
        ))}
      </div>

      <div className={styles.mascotWrap}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/gifts/tier-02/body.png" alt="" className={styles.mascot} draggable={false} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/gifts/tier-02/eyelid.png" alt="" className={styles.lid} draggable={false} />

        <div className={`${styles.fx} ${styles.fxAntenna}`} />
        <div className={`${styles.fx} ${styles.fxGlint}`}>
          <StarSvg />
        </div>
        <div className={`${styles.fx} ${styles.fxBubble}`}>ฝันดีนะ ✦</div>

        {BURSTS.map((style, i) => (
          <div
            key={i}
            className={`${styles.fx} ${styles.fxBurst} ${i % 2 ? styles.fxBurstAlt : ''}`}
            style={style}
          >
            <StarSvg />
          </div>
        ))}
      </div>
    </div>
  );
}
