/**
 * The creator's plan, as a pill.
 *
 * Shown wherever a tier needs to be visible at a glance — the quota widget,
 * the quota page header, the tier comparison table. Deliberately small and
 * dependency-free (no hook, no fetch): the tier is always already in hand
 * wherever this renders, and a badge that fetched its own would put four
 * reads on a page that shows four badges.
 *
 * Unknown tiers fall back to the Free styling rather than rendering nothing:
 * a tier this build has not heard of is still a real plan the creator is on.
 */

import type { CreatorTier } from '@/lib/creator/quota';

interface TierStyle {
  label: string;
  /** Everything but the size, so the two sizes share one definition. */
  className: string;
}

const TIER_STYLES: Record<CreatorTier, TierStyle> = {
  free: {
    label: 'Free',
    className: 'border border-white/15 bg-white/[0.06] text-white/70',
  },
  pro: {
    label: 'Pro',
    className:
      'border border-purple-400/30 bg-gradient-to-r from-purple-500/30 to-purple-400/20 text-purple-100',
  },
  star: {
    label: 'Star ⭐',
    className:
      'border border-cyan-300/30 bg-gradient-to-r from-purple-500/35 to-cyan-400/30 text-white',
  },
  enterprise: {
    label: 'Enterprise 👑',
    className:
      'border border-amber-300/35 bg-gradient-to-r from-amber-400/30 to-yellow-200/20 text-amber-100',
  },
};

const SIZE_CLASS = {
  sm: 'px-2 py-0.5 text-[11px]',
  md: 'px-3 py-1 text-xs',
} as const;

interface TierBadgeProps {
  /** creators.content_tier / creator_content_quotas.tier. */
  tier: CreatorTier;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
}

export function TierBadge({ tier, size = 'md', className = '' }: TierBadgeProps) {
  const style = TIER_STYLES[tier] ?? TIER_STYLES.free;

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full font-bold tracking-wide ${SIZE_CLASS[size]} ${style.className} ${className}`}
    >
      {style.label}
    </span>
  );
}
