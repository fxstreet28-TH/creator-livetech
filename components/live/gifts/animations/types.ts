/**
 * What every tier animation is handed, and the deterministic scatter they all
 * decorate themselves with.
 *
 * ONE CYCLE, ONE TIMELINE
 *
 * Each animation is a 300 × 300 `.stage` whose layers are all keyed off a
 * single `--cycle` duration and the SAME percentage marks. That is what keeps
 * an arm in step with the body it belongs to: two layers with independent
 * durations drift apart within a couple of seconds, and no amount of tuning
 * fixes it because the drift is per-frame rounding, not a wrong number.
 *
 * `--cycle` comes from `gift_tiers.duration_ms`, so a tier's animation is
 * exactly as long as the queue believes it is. Every animation runs ONCE with
 * `forwards` — a looping overlay would still be playing when the next gift
 * arrived.
 */

import type { CSSProperties } from 'react';

export interface GiftAnimationProps {
  /** `gift_tiers.duration_ms`, already clamped by decodeGiftEvent. */
  durationMs: number;
  /**
   * Fired once the arc has played out.
   *
   * NOT what removes the gift from the screen — the queue's clock owns that,
   * and a component that could retire itself would be a second authority that
   * disagrees with it after a backgrounded tab throttles timers. This is for
   * anything that should follow the animation rather than the schedule: the
   * caption's fade, a sound cue.
   */
  onDone?: () => void;
  /**
   * True under `prefers-reduced-motion`. The mascot is rendered STILL rather
   * than not at all: a gift is a payment, and the confirmation that it landed
   * is not decoration to be switched off.
   */
  reduceMotion?: boolean;
  /**
   * The tier this gift is, so the fallback animation can find its mascot.
   *
   * The four named tiers ignore it — each one hardcodes its own layer paths,
   * because a bespoke animation and its art are one thing and indirecting
   * between them buys nothing. TierGenericFloat is the opposite: it is ONE
   * animation serving several tiers, so it has to be told which.
   */
  tierId?: number;
  /** The rarity's accent colour, for the fallback's glow and sparkles. */
  tint?: string;
  className?: string;
}

/** One decorative particle, positioned and delayed by its index alone. */
export interface Sparkle {
  /** Percent across the stage. */
  x: number;
  y: number;
  /** Travel, in px, as CSS custom properties on the element. */
  dx: number;
  dy: number;
  /** Fraction of `--cycle` to wait before starting. */
  delay: number;
  /** 0.6-1.4, so they are not all the same size. */
  scale: number;
}

/**
 * A fixed scatter of `count` particles.
 *
 * Deterministic on purpose, and not seeded by anything: `Math.random()` here
 * would produce different positions on the server and on the client and
 * hydrate with a mismatch warning on every gift. The golden angle is what keeps
 * a purely index-driven layout from looking like a clock face — successive
 * points land in the largest remaining gap, which is why sunflowers use it.
 */
const GOLDEN_ANGLE = 137.507_764_05;

export function sparkleRing(count: number, radius = 46): Sparkle[] {
  const out: Sparkle[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i * GOLDEN_ANGLE * Math.PI) / 180;
    // sqrt keeps the density even rather than crowding the centre.
    const distance = radius * Math.sqrt((i + 0.5) / count);
    out.push({
      x: 50 + (Math.cos(angle) * distance) / 3,
      y: 52 + (Math.sin(angle) * distance) / 3,
      dx: Math.cos(angle) * (radius + 24),
      dy: Math.sin(angle) * (radius + 24) - 26,
      delay: ((i * 7) % count) / count,
      scale: 0.6 + ((i * 5) % 9) / 11,
    });
  }
  return out;
}

/** The inline custom properties a `.sparkle` element reads. */
export function sparkleStyle(sparkle: Sparkle): CSSProperties {
  return {
    left: `${sparkle.x}%`,
    top: `${sparkle.y}%`,
    '--dx': `${sparkle.dx}px`,
    '--dy': `${sparkle.dy}px`,
    '--delay': `${sparkle.delay}`,
    '--scale': sparkle.scale,
  } as CSSProperties;
}

/**
 * The stage's own custom properties.
 *
 * `--cycle` is the master duration every keyframe in every layer is expressed
 * against. Under reduced motion it is still set — the layers simply do not
 * reference it — so nothing has to branch on a missing variable.
 */
export function stageStyle(durationMs: number, extra?: CSSProperties): CSSProperties {
  return { '--cycle': `${durationMs}ms`, ...extra } as CSSProperties;
}
