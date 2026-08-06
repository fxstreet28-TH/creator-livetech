'use client';
import { useState, type CSSProperties } from 'react';
import { useReducedMotion } from 'framer-motion';

const DEFAULT_STAR_COUNT = 24;

interface Star {
  size: number;
  left: number;
  opacity: number;
  drift: number;
  duration: number;
  delay: number;
}

interface StarFieldProps {
  /** Number of particles to render. Defaults to 24 (signup modal aside). */
  count?: number;
}

function makeStars(count: number): Star[] {
  return Array.from({ length: count }, () => ({
    size: 2 + Math.random(), // 2–3px
    left: Math.random() * 100, // 0–100%
    opacity: 0.6 + Math.random() * 0.3, // 0.6–0.9
    drift: (Math.random() * 2 - 1) * 20, // ±20px
    duration: 6 + Math.random() * 8, // 6–14s
    delay: Math.random() * 8, // 0–8s
  }));
}

/**
 * Ambient falling-star particles for the signup modal aside / dashboard hero.
 *
 * Motion is pure CSS (see `.aurum-star` / `@keyframes aurum-star-fall` in
 * globals.css) so the looping particles stay cheap and add ~no JS runtime cost.
 * The random layout is generated once on mount (in an effect, so no impure
 * calls happen during render) and stays stable across re-renders. Renders
 * nothing when the user prefers reduced motion. Must live inside an
 * `overflow-hidden`, `position: relative` parent.
 */
export function StarField({ count = DEFAULT_STAR_COUNT }: StarFieldProps = {}) {
  const reduceMotion = useReducedMotion();
  // Generated once, lazily, on first render — stable across re-renders and not
  // recomputed on every render. `count` is fixed per usage (24 modal / 12 hero).
  const [stars] = useState<Star[]>(() => makeStars(count));

  if (reduceMotion) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      {stars.map((s, i) => (
        <span
          key={i}
          className="aurum-star"
          style={
            {
              width: `${s.size}px`,
              height: `${s.size}px`,
              left: `${s.left}%`,
              animationDuration: `${s.duration}s`,
              animationDelay: `${s.delay}s`,
              '--star-op': s.opacity,
              '--star-drift': `${s.drift}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
