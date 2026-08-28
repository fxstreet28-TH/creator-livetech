'use client';

import { useId } from 'react';
import styles from './PrismStar.module.css';

export interface PrismStarProps {
  /** Rendered size in pixels. Square. Default 72. */
  size?: number;
  /** Play animations. Default true. Auto-disabled if user prefers-reduced-motion. */
  animated?: boolean;
  /**
   * Include the outer "super charge" effect (concentric waves + 8 lightning bolts + rotating core).
   * Default true — set false in dense contexts (transaction rows, tiny badges) where the effect
   * is too visually loud or overflows the parent.
   */
  showChargeEffects?: boolean;
  /** Extra class for the root <svg>. */
  className?: string;
  /** Accessible label. Default 'Star'. */
  'aria-label'?: string;
}

export function PrismStar({
  size = 72,
  animated = true,
  showChargeEffects = true,
  className = '',
  'aria-label': ariaLabel = 'Star',
}: PrismStarProps) {
  const rawId = useId();
  const uid = rawId.replace(/[:]/g, '');

  const gPrism = `prism-${uid}`;
  const gHalo = `halo-${uid}`;
  const gGlow = `glow-${uid}`;

  const rootClass = [
    styles.star,
    animated && styles.animated,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      className={rootClass}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient
          id={gPrism}
          x1="35"
          y1="22"
          x2="164"
          y2="178"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFD9FF" />
          <stop offset=".25" stopColor="#C77DFF" />
          <stop offset=".58" stopColor="#7B5CFF" />
          <stop offset="1" stopColor="#18D9EE" />
        </linearGradient>
        <radialGradient id={gHalo}>
          <stop stopColor="#8B5CFF" stopOpacity=".48" />
          <stop offset="1" stopOpacity="0" />
        </radialGradient>
        <filter id={gGlow} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Halo (breathing) */}
      <circle className={styles.halo} cx="100" cy="100" r="90" fill={`url(#${gHalo})`} />

      {/* Luxury orbit (counter-rotating dashed ellipse with satellite) */}
      <g className={styles.luxuryOrbit}>
        <ellipse
          cx="100"
          cy="100"
          rx="91"
          ry="48"
          fill="none"
          stroke="#B98BFF"
          strokeWidth="1.2"
          strokeDasharray="1 9"
        />
        <circle cx="10" cy="100" r="3.5" fill="#fff" />
      </g>

      {/* Super charge: expanding waves + lightning bolts + rotating core */}
      {showChargeEffects && (
        <g className={styles.superCharge} fill="none" strokeLinecap="round">
          <circle
            className={`${styles.chargeWave} ${styles.waveA}`}
            cx="100"
            cy="100"
            r="58"
            stroke="#D7B8FF"
            strokeWidth="2"
          />
          <circle
            className={`${styles.chargeWave} ${styles.waveB}`}
            cx="100"
            cy="100"
            r="69"
            stroke="#43E8FF"
            strokeWidth="1.5"
          />
          <g className={styles.chargeBolts} stroke="#BFF8FF" strokeWidth="2.6">
            <path d="M100 8L95 35l8-4-4 24M173 42l-22 17 9 1-20 17M190 116l-30-5 6 8-25-7M148 181l-16-28-2 11-12-25M49 180l16-28-10 5 20-20M10 116l30-5-7 8 26-7M27 42l22 17-9 1 21 17" />
          </g>
          <circle
            className={styles.chargeCore}
            cx="100"
            cy="100"
            r="52"
            stroke="#fff"
            strokeWidth="2"
          />
        </g>
      )}

      {/* Prism ring (dashed rotating) */}
      <circle
        className={styles.prismRing}
        cx="100"
        cy="100"
        r="74"
        fill="none"
        stroke="#AA75FF"
        strokeWidth="2"
        strokeDasharray="2 10"
      />

      {/* Star (3D-spinning prism-gradient, no inner white overlays) */}
      <g className={styles.starBody} filter={`url(#${gGlow})`}>
        <g className={styles.starSpin}>
          <path
            d="M100 22L121 70 174 75 134 111 146 164 100 136 54 164 66 111 26 75 79 70Z"
            fill={`url(#${gPrism})`}
            stroke="#F0DDFF"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </g>
      </g>

      {/* Sparkles (2 stars + 1 orbit dot) */}
      <g className={styles.sparkles} fill="#FFF5B5">
        <path d="M35 35l3 8 8 3-8 3-3 8-3-8-8-3 8-3zM167 44l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />
        <circle cx="166" cy="148" r="3" />
      </g>
    </svg>
  );
}
