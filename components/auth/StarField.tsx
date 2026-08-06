'use client';
import { useMemo, type CSSProperties } from 'react';
import { useReducedMotion } from 'framer-motion';

const STAR_COUNT = 24;

interface Star {
  size: number;
  left: number;
  opacity: number;
  drift: number;
  duration: number;
  delay: number;
}

/**
 * Ambient falling-star particles for the signup modal's left aside.
 *
 * Motion is pure CSS (see `.aurum-star` / `@keyframes aurum-star-fall` in
 * globals.css) so 24 looping particles stay cheap and add ~no JS runtime cost.
 * The random layout is computed once via useMemo so the same star set stays
 * stable across re-renders. Renders nothing when the user prefers reduced
 * motion. Must live inside an `overflow-hidden`, `position: relative` parent.
 */
export function StarField() {
  const reduceMotion = useReducedMotion();

  const stars = useMemo<Star[]>(() => {
    return Array.from({ length: STAR_COUNT }, () => ({
      size: 2 + Math.random(), // 2–3px
      left: Math.random() * 100, // 0–100%
      opacity: 0.6 + Math.random() * 0.3, // 0.6–0.9
      drift: (Math.random() * 2 - 1) * 20, // ±20px
      duration: 6 + Math.random() * 8, // 6–14s
      delay: Math.random() * 8, // 0–8s
    }));
  }, []);

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
