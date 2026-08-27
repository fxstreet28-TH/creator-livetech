/**
 * Star wallet helpers — the shared money layer for Phase 1.
 *
 * Every mutation in here is a single RPC call, not a sequence of
 * supabase-js statements. The requirements doc specifies deductStarsFIFO
 * as "MUST be called inside a database transaction. Uses SELECT FOR
 * UPDATE to prevent race conditions" — supabase-js exposes no
 * transaction API and cannot take row locks, so a read-modify-write
 * expressed in TypeScript cannot honour that contract: two concurrent
 * spends read the same balance and both succeed. The read-modify-write
 * therefore lives in plpgsql (migration `phase1_wallet_rpcs`), and these
 * functions are thin typed wrappers over it. The exported signatures and
 * return shapes are exactly as specified.
 *
 * The RPCs are SECURITY DEFINER and revoked from anon/authenticated, so
 * these helpers only work through a service-role client.
 *
 * Invariant maintained throughout:
 *   stars_wallet.total_balance == SUM(star_purchases.remaining_stars)
 */

import { SupabaseClient } from '@supabase/supabase-js';

/** Section 5.1: 1 Star = 10 THB, flat, no bulk bonus. */
export const THB_PER_STAR = 10;

/** Section 5.1: anti-money-laundering wallet ceiling. Enforced in-database. */
export const MAX_WALLET_STARS = 50_000;

/**
 * Purchase bounds, mirrored by star_purchases' CHECK constraint.
 *
 * Widened from the 100-10000 of Section 5.1 by the Week 3 migration: the
 * smallest PromptPay QR worth showing is 10 stars (110 THB at launch
 * pricing), and the old floor rejected it at credit time — after the buyer
 * had already paid.
 *
 * The upper bound is a ceiling on one purchase, not on what a wallet can
 * hold: MAX_WALLET_STARS still applies, and create-payment-intent checks a
 * purchase against it before Stripe is involved so nobody pays for stars
 * the credit path would refuse.
 */
export const MIN_PURCHASE_STARS = 10;
export const MAX_PURCHASE_STARS = 100_000;

export interface FIFODeductionResult {
  success: boolean;
  deducted_from_batches: Array<{ purchase_id: string; stars: number }>;
  new_wallet_balance: number;
  error?: string;
}

export type StarPaymentMethod =
  /** Week 3 PromptPay QR — the only live purchase path. */
  | 'stripe_promptpay'
  | 'stripe'
  | 'oxapay'
  | 'manual_admin';

/**
 * Transaction types written to star_transactions.transaction_type.
 *
 * The column is plain TEXT with no CHECK constraint (Section 6). Section 6's
 * comment omits 'purchase', which every credit path writes; the allowed set
 * is enumerated here instead until the Phase 2 hardening batch adds the
 * constraint.
 */
export type StarTransactionType =
  | 'purchase'
  | 'subscribe'
  | 'ppv_unlock'
  | 'ppv_message'
  | 'tip'
  | 'buyback'
  | 'expiration';

/**
 * Deduct N stars from a user's wallet using FIFO (oldest expiry first).
 *
 * Atomic: the wallet row and the candidate batches are locked FOR UPDATE
 * for the duration, so concurrent callers serialise rather than both
 * spending the same balance. Batches are consumed in expires_at order,
 * which is what makes soon-to-expire Stars get used before fresh ones.
 *
 * Writes the star_transactions row itself, recording which batches were
 * drawn down in purchase_batch_ids.
 */
export async function deductStarsFIFO(
  supabase: SupabaseClient,
  userId: string,
  starsToDeduct: number,
  opts?: {
    transactionType?: StarTransactionType;
    referenceId?: string;
    referenceType?: string;
    creatorId?: string;
  },
): Promise<FIFODeductionResult> {
  const { data, error } = await supabase.rpc('deduct_stars_fifo', {
    p_user_id: userId,
    p_stars: starsToDeduct,
    p_transaction_type: opts?.transactionType ?? 'ppv_unlock',
    p_reference_id: opts?.referenceId ?? null,
    p_reference_type: opts?.referenceType ?? null,
    p_creator_id: opts?.creatorId ?? null,
  });

  if (error) {
    return {
      success: false,
      deducted_from_batches: [],
      new_wallet_balance: 0,
      error: error.message,
    };
  }

  return data as FIFODeductionResult;
}

export interface AddStarsResult {
  success: boolean;
  purchase_id?: string;
  new_wallet_balance?: number;
  expires_at?: string;
  /** True when payment_provider_id had already been credited. */
  idempotent_replay?: boolean;
  error?: string;
  /**
   * True when the RPC call itself failed (database unreachable, permission
   * denied, an unexpected exception) rather than the RPC deciding not to
   * credit. The distinction matters to stripe-webhook: a business rejection
   * will reject identically forever and wants a human, while a transport
   * failure is exactly what Stripe's redelivery schedule exists to fix.
   */
  transport_error?: boolean;
}

/**
 * Credit stars to a user's wallet from a purchase.
 *
 * Atomic: the purchase batch insert, the wallet increment and the
 * star_transactions row land together or not at all. Doing them as three
 * round trips (as the sample did) can leave a purchase batch the wallet
 * aggregate does not reflect, breaking the balance == SUM(remaining)
 * invariant with no way to tell after the fact.
 *
 * Idempotent by payment_provider_id, which carries a unique index. A
 * replay of an already-succeeded provider id returns the original
 * purchase with idempotent_replay: true and credits nothing. A provider
 * id that exists in a non-succeeded state is reported as an error rather
 * than falling through to an insert that would violate the index.
 *
 * Expiry is NOW() + INTERVAL '6 months' computed in Postgres, not
 * JS setMonth(+6) — the latter overflows short months (Aug 31 lands on
 * Mar 3 rather than Feb 28).
 *
 * Rejects credits that would push the wallet past MAX_WALLET_STARS.
 */
export async function addStarsToWallet(
  supabase: SupabaseClient,
  userId: string,
  starsAmount: number,
  thbAmount: number,
  paymentMethod: StarPaymentMethod,
  paymentProviderId: string,
  metadata?: Record<string, unknown>,
): Promise<AddStarsResult> {
  const { data, error } = await supabase.rpc('credit_stars_purchase', {
    p_user_id: userId,
    p_stars: starsAmount,
    p_thb: thbAmount,
    p_payment_method: paymentMethod,
    p_payment_provider_id: paymentProviderId,
    p_metadata: metadata ?? {},
  });

  if (error) return { success: false, error: error.message, transport_error: true };

  return data as AddStarsResult;
}

export interface ExpireBatchesResult {
  batches_expired: number;
  stars_expired_total: number;
  detail: Array<{ purchase_id: string; user_id: string; stars_expired: number }>;
}

/**
 * Expire every purchase batch past its expires_at that still holds stars.
 *
 * Section 8.10 step 3. Per batch: zero remaining_stars, subtract from the
 * wallet's total_balance, add to total_expired, and log an 'expiration'
 * transaction — atomically, so a failure part-way cannot leave the wallet
 * disagreeing with the batches.
 *
 * Naturally idempotent: a second run in the same day finds nothing with
 * remaining_stars > 0 left to expire and reports zero.
 */
export async function expireStarBatches(
  supabase: SupabaseClient,
): Promise<{ success: boolean; result?: ExpireBatchesResult; error?: string }> {
  const { data, error } = await supabase.rpc('expire_star_batches');
  if (error) return { success: false, error: error.message };
  return { success: true, result: data as ExpireBatchesResult };
}

export interface ActivePricing {
  id: string;
  retail_thb_per_star: number;
  internal_thb_per_star: number;
  label: string;
}

/**
 * The live retail price of a star, from star_pricing_config.
 *
 * A partial unique index allows at most one row with is_active = true, so
 * this cannot return an ambiguous answer — but it can return none, if a
 * price switch left no row active. Callers must treat null as "cannot
 * sell right now" (no_active_pricing) rather than falling back to a
 * hardcoded number: a wrong price here is a wrong charge.
 */
export async function getActivePricing(
  supabase: SupabaseClient,
): Promise<{ pricing?: ActivePricing; error?: string }> {
  const { data, error } = await supabase
    .from('star_pricing_config')
    .select('id, retail_thb_per_star, internal_thb_per_star, label')
    .eq('is_active', true)
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: 'no active pricing row' };

  return { pricing: data as ActivePricing };
}

/**
 * Price a purchase, in satang.
 *
 * Stripe charges in minor units, and THB has two of them. The arithmetic
 * runs in integers from the start — retail is converted to satang once,
 * then multiplied — because 11.10 * 500 * 100 in binary floating point is
 * 554999.9999999999, and rounding that at the end is a satang lost on
 * arbitrary amounts.
 */
export function priceInSatang(stars: number, retailThbPerStar: number): {
  amountSatang: number;
  amountThb: number;
} {
  const retailSatang = Math.round(retailThbPerStar * 100);
  const amountSatang = retailSatang * stars;
  return { amountSatang, amountThb: amountSatang / 100 };
}
