'use client';

/**
 * Tier 04 — Nova. A meteor falls on Earth; น้อง Aurum launches, charges a nova
 * beam from the chest, shatters it, and lands back to a hero pose.
 *
 * A 1:1 port of `docs/gift-cards/aurum-live-tier04-nova.html`, and the longest
 * of the four at ten seconds — every beat of it is in the module CSS's header.
 * `docs/gift-cards/reference/tier04.mp4` is how it is meant to read in motion.
 *
 * Earth, the meteor and the beam are all CSS; the only bitmap is the mascot.
 */

import { useId, type CSSProperties } from 'react';
import { seededRandom, stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './Tier04Nova.module.css';

/** 45 sky dots, in the upper 72% of the stage — below that is Earth. */
const SKY_SEED = 0x0d04_5a11;

const SKY: CSSProperties[] = (() => {
  const rand = seededRandom(SKY_SEED);
  return Array.from({ length: 45 }, () => ({
    left: `${rand() * 100}%`,
    top: `${rand() * 72}%`,
    opacity: 0.2 + rand() * 0.7,
    transform: `scale(${0.6 + rand()})`,
  }));
})();

/**
 * Twelve fragments off the meteor:
 *
 *   const a = (i / all.length) * Math.PI * 2 + .2, d = 70 + (i % 4) * 22;
 *
 * Two in three are rock, the third an ember — `i % 3` in the reference, which
 * makes ember every third one starting at index 0.
 */
const SHARD_COUNT = 12;

const SHARDS: CSSProperties[] = Array.from({ length: SHARD_COUNT }, (_, i) => {
  const a = (i / SHARD_COUNT) * Math.PI * 2 + 0.2;
  const d = 70 + (i % 4) * 22;
  return {
    '--tx': `${Math.cos(a) * d}px`,
    '--ty': `${Math.sin(a) * d}px`,
  } as CSSProperties;
});

function RockShard() {
  return (
    <svg viewBox="0 0 14 12">
      <path d="M2 3 L7 0 L13 4 L11 11 L4 12 L0 8Z" fill="#5b4038" stroke="#fbbf24" strokeWidth="1" />
    </svg>
  );
}

function EmberShard() {
  return (
    <svg viewBox="0 0 14 12">
      <circle cx="7" cy="6" r="4" fill="#fde68a" />
    </svg>
  );
}

/** The three charge rings, offset so they pulse one after another. */
const RING_DELAYS = ['0s', '.35s', '.7s'];

export function Tier04Nova({
  durationMs,
  onDone,
  reduceMotion = false,
  className = '',
}: GiftAnimationProps) {
  useAnimationDone(durationMs, onDone);

  /**
   * The rock's gradient is referenced by id, and ids are document-global: two
   * Novas on screen would share one, and the survivor would lose its fill when
   * the other unmounted. `useId` gives each instance its own.
   */
  const rockGradientId = `${useId()}-rock`;

  return (
    <div
      aria-hidden
      className={`${styles.stage} ${reduceMotion ? styles.still : ''} ${className}`}
      style={stageStyle(durationMs)}
    >
      <div className={styles.shake}>
        <div className={styles.sky}>
          {SKY.map((style, i) => (
            <span key={i} className={styles.dot} style={style} />
          ))}
        </div>
        <div className={styles.danger} />
        <div className={styles.earth} />

        <div className={styles.meteor}>
          <div className={styles.trail} />
          <svg className={styles.rock} viewBox="0 0 52 48">
            <defs>
              <radialGradient id={rockGradientId} cx="35%" cy="30%" r="75%">
                <stop offset="0" stopColor="#9a7b6a" />
                <stop offset=".6" stopColor="#4b3630" />
                <stop offset="1" stopColor="#1f1512" />
              </radialGradient>
            </defs>
            <path
              d="M14 6 L30 2 L44 10 L50 24 L44 40 L28 46 L12 42 L3 28 L6 14 Z"
              fill={`url(#${rockGradientId})`}
              stroke="#2a1b16"
              strokeWidth="1.5"
            />
            <circle cx="20" cy="18" r="4" fill="#2a1b16" opacity=".7" />
            <circle cx="34" cy="30" r="5.5" fill="#2a1b16" opacity=".7" />
            <circle cx="16" cy="34" r="3" fill="#2a1b16" opacity=".6" />
            <path
              className={styles.crack}
              d="M22 8 L26 20 L18 26 L30 36 M26 20 L38 16 M30 36 L40 42"
              fill="none"
              stroke="#fde68a"
              strokeWidth="1.8"
              strokeLinecap="round"
              style={{ filter: 'drop-shadow(0 0 3px #fbbf24)' }}
            />
          </svg>
        </div>
        <div className={`${styles.fx} ${styles.fxAlert}`}>!</div>

        <div className={styles.hero}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/gifts/tier-04/body.png" alt="" className={styles.body} draggable={false} />
          {RING_DELAYS.map((delay) => (
            <div key={delay} className={styles.ring} style={{ '--rd': delay } as CSSProperties} />
          ))}
          <div className={styles.charge} />
          <div className={styles.beam} />
        </div>

        <div className={`${styles.fx} ${styles.fxFlash}`} />
        {SHARDS.map((style, i) => (
          <div key={i} className={`${styles.fx} ${styles.fxShard}`} style={style}>
            {i % 3 ? <RockShard /> : <EmberShard />}
          </div>
        ))}

        <div className={`${styles.fx} ${styles.fxBubble}`}>โลกปลอดภัยแล้ว ✨</div>
      </div>
    </div>
  );
}
