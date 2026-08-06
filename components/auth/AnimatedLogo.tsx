'use client';
import { useEffect } from 'react';
import Image from 'next/image';
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';

const RATIO = 1030 / 1526; // source PNG is 1526×1030
const DEFAULT_W = 160;

interface AnimatedLogoProps {
  /** Rendered width in px; height is derived from the source aspect ratio. */
  width?: number;
  className?: string;
}

/**
 * The AURUM Live mascot logo, animated as one unit:
 *  - gentle vertical float (4s, ease-in-out, infinite alternate)
 *  - a randomized "blink" (quick scaleY squash) every 4–6s
 *  - a soft spring scale + tilt on hover (desktop pointers only)
 *
 * Float + blink are disabled under prefers-reduced-motion. The box is a fixed
 * width×height so the float never reflows surrounding content, and it clips
 * itself with overflow-hidden. Reused across the signup modal and dashboard.
 */
export function AnimatedLogo({ width = DEFAULT_W, className = '' }: AnimatedLogoProps) {
  const height = Math.round(width * RATIO);
  const reduceMotion = useReducedMotion();
  const blink = useAnimationControls();

  useEffect(() => {
    if (reduceMotion) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const loop = () => {
      const wait = 4000 + Math.random() * 2000; // 4–6s
      timer = setTimeout(async () => {
        if (cancelled) return;
        await blink.start({
          scaleY: [1, 0.94, 1],
          transition: { duration: 0.12, ease: 'easeOut', times: [0, 0.5, 1] },
        });
        if (!cancelled) loop();
      }, wait);
    };
    loop();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reduceMotion, blink]);

  return (
    <motion.div
      className={`relative inline-block overflow-hidden ${className}`}
      style={{ width, height }}
      animate={reduceMotion ? undefined : { y: [-6, 6] }}
      transition={
        reduceMotion
          ? undefined
          : { duration: 4, ease: 'easeInOut', repeat: Infinity, repeatType: 'reverse' }
      }
      whileHover={{
        scale: 1.04,
        rotate: 2,
        transition: { type: 'spring', stiffness: 300, damping: 18 },
      }}
    >
      <motion.div animate={blink} style={{ transformOrigin: 'center' }}>
        <Image
          src="/aurum-live-logo.png"
          alt="AURUM Live"
          width={width}
          height={height}
          priority
          className="drop-shadow-lg"
          style={{ width, height: 'auto' }}
        />
      </motion.div>
    </motion.div>
  );
}
