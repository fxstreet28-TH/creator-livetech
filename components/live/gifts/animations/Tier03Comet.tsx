'use client';

/**
 * Tier 03 — Comet. น้อง Aurum comes in as a comet from the bottom-left, burns
 * the tail off on the way down, lands on the pad, and puts on shades.
 *
 * A 1:1 port of `docs/gift-cards/aurum-live-tier03-comet.html`.
 *
 * THE TWO-IMAGE TRICK
 *
 * `tail.png` is the comet WITH the mascot inside it — one 1024 px frame as it
 * was drawn. `body.png` is the same mascot alone. The flight shows the tail;
 * on impact the tail fades and the body, positioned at exactly the offsets the
 * mascot occupied inside that frame (109.3 / 23.4, 210.4 square), is what
 * stands up. Nothing moves at the swap because nothing has to.
 */

import { useId, type CSSProperties } from 'react';
import { seededRandom, stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './Tier03Comet.module.css';

/**
 * The backdrop, scattered once at module load.
 *
 * The reference calls `Math.random()` here; a fixed seed gives the same look
 * without the hydration mismatch — see `seededRandom` in ./types.ts.
 */
const SCENE_SEED = 0x0c03_1e7a;

const { dots: DOTS, streaks: STREAKS } = (() => {
  const rand = seededRandom(SCENE_SEED);
  const dots: CSSProperties[] = Array.from({ length: 40 }, () => ({
    left: `${rand() * 100}%`,
    top: `${rand() * 100}%`,
    opacity: 0.2 + rand() * 0.6,
  }));
  const streaks: CSSProperties[] = Array.from({ length: 14 }, () => ({
    '--x': `${20 + rand() * 90}%`,
    '--y': `${-10 + rand() * 90}%`,
    '--w': `${50 + rand() * 90}px`,
    '--d': `-${(rand() * 0.55).toFixed(2)}s`,
  }) as CSSProperties);
  return { dots, streaks };
})();

/**
 * Ten impact sparks fanning out from the landing point:
 *
 *   const a = Math.PI + (i / (all.length - 1)) * Math.PI, d = 70 + (i % 3) * 25;
 *
 * The half-turn from π to 2π is what keeps them in the upper half — sparks
 * that flew downward would go straight through the pad.
 */
const SPARK_COUNT = 10;

const SPARKS: CSSProperties[] = Array.from({ length: SPARK_COUNT }, (_, i) => {
  const a = Math.PI + (i / (SPARK_COUNT - 1)) * Math.PI;
  const d = 70 + (i % 3) * 25;
  return {
    '--tx': `${Math.cos(a) * d}px`,
    '--ty': `${Math.sin(a) * d * 0.55}px`,
  } as CSSProperties;
});

export function Tier03Comet({
  durationMs,
  onDone,
  reduceMotion = false,
  className = '',
}: GiftAnimationProps) {
  useAnimationDone(durationMs, onDone);

  /**
   * The lens clip-path needs an id, and ids are document-global: two gifts on
   * screen at once — a tray Comet under a fullscreen one — would both resolve
   * `url(#lensClip)` to whichever mounted first, and the glint would vanish
   * when that one unmounted. `useId` gives each instance its own.
   */
  const lensClipId = `${useId()}-lens`;

  return (
    <div
      aria-hidden
      className={`${styles.stage} ${reduceMotion ? styles.still : ''} ${className}`}
      style={stageStyle(durationMs)}
    >
      <div className={styles.shake}>
        <div className={styles.scene}>
          {DOTS.map((style, i) => (
            <span key={`d${i}`} className={styles.dot} style={style} />
          ))}
          {STREAKS.map((style, i) => (
            <span key={`s${i}`} className={styles.streak} style={style} />
          ))}
        </div>

        <div className={styles.pad} />
        <div className={`${styles.fx} ${styles.fxShock}`} />
        {SPARKS.map((style, i) => (
          <div
            key={i}
            className={`${styles.fx} ${styles.fxSpark} ${i % 2 ? styles.fxSparkAlt : ''}`}
            style={style}
          />
        ))}

        <div className={styles.flyer}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/gifts/tier-03/tail.png" alt="" className={styles.tail} draggable={false} />
          <div className={styles.bodyWrap}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/gifts/tier-03/body.png" alt="" className={styles.body} draggable={false} />

            {/* Pixel "deal with it" shades — 1 unit = 1 viewBox px; the eyes sit
                under the lens centres at (4, 2.5) and (14, 2.5). */}
            <svg className={styles.shades} viewBox="-2 0 22 6">
              <defs>
                <clipPath id={lensClipId}>
                  <rect x="0" y="0" width="8" height="5" />
                  <rect x="10" y="0" width="8" height="5" />
                </clipPath>
              </defs>
              <g fill="#0b0b0f">
                {/* left lens (stepped bottom) */}
                <rect x="0" y="0" width="8" height="3" />
                <rect x="1" y="3" width="7" height="1" />
                <rect x="2" y="4" width="5" height="1" />
                {/* right lens */}
                <rect x="10" y="0" width="8" height="3" />
                <rect x="10" y="3" width="7" height="1" />
                <rect x="11" y="4" width="5" height="1" />
                {/* bridge + arms */}
                <rect x="8" y="0" width="2" height="1" />
                <rect x="-2" y="0" width="2" height="1" />
                <rect x="18" y="0" width="2" height="1" />
              </g>
              {/* checker highlights */}
              <g fill="#fff">
                <rect x="2" y="1" width="1" height="1" />
                <rect x="4" y="1" width="1" height="1" />
                <rect x="1" y="2" width="1" height="1" />
                <rect x="3" y="2" width="1" height="1" />
                <rect x="12" y="2" width="1" height="1" />
                <rect x="14" y="2" width="1" height="1" />
                <rect x="11" y="3" width="1" height="1" />
                <rect x="13" y="3" width="1" height="1" />
              </g>
              <g clipPath={`url(#${lensClipId})`}>
                <rect
                  className={styles.glint}
                  x="2"
                  y="0"
                  width="2"
                  height="6"
                  fill="#fff"
                  opacity="0.35"
                  transform="skewX(-20)"
                />
              </g>
            </svg>
          </div>
        </div>

        <div className={`${styles.fx} ${styles.fxBubble}`}>ลงจอดเรียบร้อย 🚀</div>
      </div>
    </div>
  );
}
