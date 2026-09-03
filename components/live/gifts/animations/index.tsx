'use client';

/**
 * `gift_tiers.animation_key` → the component that plays it.
 *
 * The ONE place that mapping exists, and the only thing a new bespoke
 * animation has to touch besides its own two files.
 *
 * WHY A DISPATCHER COMPONENT AND NOT A LOOKUP TABLE
 *
 * The obvious shape is `const Animation = REGISTRY[key]` at the call site, and
 * it is wrong in a way that only shows up under React's own lint rules: to the
 * compiler, a component type resolved during render is a component CREATED
 * during render, and a component created during render remounts — losing its
 * state, and here restarting its animation — whenever the parent re-renders.
 * The parent in this case is an overlay sitting beside a live chat panel, so it
 * re-renders constantly.
 *
 * Rendering `<GiftAnimation animationKey={...} />` instead makes every branch a
 * component declared at module scope. React sees a stable element type per
 * branch, the animation keeps running across the parent's re-renders, and the
 * default arm gives the fallback for free.
 *
 * THE DEFAULT ARM IS LOad-BEARING
 *
 * A tier is a database row. The CEO can add one, or repoint an existing one at
 * a different key, with no deploy — so an unrecognised key is a NORMAL
 * condition with a defined outcome, not an error. It renders TierGenericFloat,
 * which means a gift somebody paid 3,000 stars for still animates on a build
 * that has never heard of it.
 */

import type { GiftAnimationProps } from './types';
import { Tier01Stardust } from './Tier01Stardust';
import { Tier02Moonlight } from './Tier02Moonlight';
import { Tier03Comet } from './Tier03Comet';
import { Tier04Nova } from './Tier04Nova';
import { TierGenericFloat } from './TierGenericFloat';

export interface GiftAnimationSlotProps extends GiftAnimationProps {
  /** `gift_tiers.animation_key`. Anything unrecognised falls through. */
  animationKey: string;
}

export function GiftAnimation({ animationKey, ...props }: GiftAnimationSlotProps) {
  switch (animationKey) {
    case 'stardust':
      return <Tier01Stardust {...props} />;
    case 'moonlight':
      return <Tier02Moonlight {...props} />;
    case 'comet':
      return <Tier03Comet {...props} />;
    case 'nova':
      return <Tier04Nova {...props} />;
    default:
      return <TierGenericFloat {...props} />;
  }
}

export { Tier01Stardust, Tier02Moonlight, Tier03Comet, Tier04Nova, TierGenericFloat };
export type { GiftAnimationProps };
