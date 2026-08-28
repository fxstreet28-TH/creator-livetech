/**
 * Star purchase and buyback bounds, mirrored from the backend.
 *
 * These are duplicates of supabase/functions/_shared/stars.ts and the CHECK
 * constraints in the Week 3 migration, and they are duplicated on purpose:
 * the browser bundle cannot import Deno modules, and a form that only learns
 * "10 is the minimum" from a rejected round trip is a worse form. The
 * backend remains the authority — every value here is re-checked by
 * create-payment-intent, request_buyback, or a CHECK constraint, so a drift
 * between the two costs a confusing error message, never a bad transaction.
 *
 * If you change one of these, change its counterpart in the same PR.
 */

/** Smallest purchase worth a PromptPay QR. 110 THB at launch pricing. */
export const MIN_PURCHASE_STARS = 10;

/** Ceiling on a single purchase, not on what a wallet may hold. */
export const MAX_PURCHASE_STARS = 100_000;

/** AML wallet ceiling (§ 5.1). Enforced in credit_stars_purchase. */
export const MAX_WALLET_STARS = 50_000;

/** buyback_requests CHECK (star_amount >= 10). */
export const MIN_BUYBACK_STARS = 10;

/**
 * Fixed buyback rate, CHECK-pinned in buyback_requests and hardcoded in
 * request_buyback. Policy, not configuration — it is not read from
 * star_pricing_config and must never be presented as negotiable.
 */
export const BUYBACK_THB_PER_STAR = 3;

export interface StarPreset {
  stars: number;
  /** Thai label under the amount, or null for the plain tiles. */
  badge: string | null;
  /** Exactly one preset carries this; it gets the highlighted treatment. */
  highlighted?: boolean;
}

/**
 * The preset tiles, in ascending order. Deliberately carry no "save X%"
 * copy: pricing is flat per star at every tier, and a struck-through
 * comparison price would be inventing a discount that does not exist.
 */
export const STAR_PRESETS: StarPreset[] = [
  { stars: 10, badge: 'เริ่มต้น' },
  { stars: 50, badge: 'ยอดนิยม', highlighted: true },
  { stars: 100, badge: 'คุ้มค่า' },
  { stars: 500, badge: null },
  { stars: 1_000, badge: null },
  { stars: 5_000, badge: null },
];

/**
 * Allowed slider stops, coarsening as the amount grows: 10s to 100, 50s to
 * 1,000, 500s to 10,000, then 5,000s to 100,000. A linear 10-100,000 slider
 * would make every amount under about 2,000 — which is most real purchases —
 * unreachable inside the first two pixels of travel.
 *
 * Built once at module load: 64 stops, and the array is the slider's index
 * space (`<input type="range" max={SLIDER_STOPS.length - 1}>`).
 *
 * The text input beside the slider is NOT restricted to these stops. It
 * accepts any integer in range, and the slider snaps to the nearest stop for
 * display — the ladder is an input affordance, not a validation rule.
 */
function buildSliderStops(): number[] {
  const stops: number[] = [];
  const ladder: Array<{ upTo: number; step: number }> = [
    { upTo: 100, step: 10 },
    { upTo: 1_000, step: 50 },
    { upTo: 10_000, step: 500 },
    { upTo: 100_000, step: 5_000 },
  ];

  let value = MIN_PURCHASE_STARS;
  stops.push(value);

  for (const { upTo, step } of ladder) {
    while (value + step <= upTo) {
      value += step;
      stops.push(value);
    }
  }
  return stops;
}

export const SLIDER_STOPS: number[] = buildSliderStops();

/** Index of the stop closest to `stars`, for positioning the slider thumb. */
export function nearestStopIndex(stars: number): number {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < SLIDER_STOPS.length; i += 1) {
    const distance = Math.abs(SLIDER_STOPS[i] - stars);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}
