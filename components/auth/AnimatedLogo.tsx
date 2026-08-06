'use client';
import { useEffect } from 'react';
import Image from 'next/image';
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';

const LOGO_W = 200;
const LOGO_H = 135; // 1526×1030 source → 200px wide keeps the aspect ratio

/**
 * The AURUM Live mascot logo, animated as one unit:
 *  - gentle vertical float (4s, ease-in-out, infinite alternate)
 *  - a randomized "blink" (quick scaleY squash) every 4–6s
 *  - a soft spring scale + tilt on hover (desktop pointers only)
 *
 * Float + blink are disabled under prefers-reduced-motion. The box is a fixed
 * 200×135 so the float never reflows the surrounding aside content.
 */
export function AnimatedLogo() {
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
      className="relative z-10 mb-16 inline-block"
      style={{ width: LOGO_W, height: LOGO_H }}
      animate={reduceMotion ? undefined : { y: [-6, 6] }}
      transition={
        reduceMotion
          ? undefined
          : { duration: 4, ease: 'easeInOut', repeat: Infinity, repeatType: 'reverse' }
      }
      whileHover={{
        scale: 1.04,
        rotate: 2,
        // Spring only applies to the hover-driven props; the float keeps its
        // own tween on the top-level `transition` prop above.
        transition: { type: 'spring', stiffness: 300, damping: 18 },
      }}
    >
      <motion.div animate={blink} style={{ transformOrigin: 'center' }}>
        <Image
          src="/aurum-live-logo.png"
          alt="AURUM Live"
          width={LOGO_W}
          height={LOGO_H}
          priority
          className="drop-shadow-lg"
          style={{ width: LOGO_W, height: 'auto' }}
        />
      </motion.div>
    </motion.div>
  );
}
