/**
 * wallet-pricing — GET /wallet-pricing (Week 3 frontend).
 *
 * Hands the buy screen the one number it cannot compute for itself: what a
 * star retails for right now. Everything the screen shows — every preset
 * tile total, the slider readout, the submit button — multiplies out from
 * this, so the alternative to an endpoint is a hardcoded 11.00 in the
 * bundle that a pricing change could not reach.
 *
 * GET -> { retail_thb_per_star, label }
 *
 * Reads through serviceClient() rather than userClient() on purpose. The
 * live price is not user-scoped data, and star_pricing_read_active already
 * exposes the active row to any signed-in caller; going through the service
 * key just means the column list below — not an RLS policy written for a
 * different purpose — decides what leaves this function.
 *
 * internal_thb_per_star is deliberately absent from that column list. It is
 * the creator-payout settlement basis (§ 5.1), and the markup between it and
 * retail is the platform's margin: not a number any buy screen has business
 * rendering, and not one that should be sitting in a browser payload waiting
 * to be rendered by mistake. Adding it here would be the whole leak.
 *
 * Deployed with verify_jwt: true — same as every other wallet endpoint. The
 * price is not a secret, but an unauthenticated pricing endpoint is a free
 * scraping target and there is no caller for it that is not signed in.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { serviceClient } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  try {
    const supabase = serviceClient();

    // star_pricing_config_only_one_active makes maybeSingle() safe: two live
    // rows cannot exist, so this is "the price" or nothing.
    const { data, error } = await supabase
      .from('star_pricing_config')
      .select('retail_thb_per_star, label')
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.error('[wallet-pricing] pricing fetch failed', error);
      return errorResponse('internal_error', origin, 'Pricing fetch failed');
    }
    if (!data) {
      // 503 via no_active_pricing, matching create-payment-intent: no live
      // row is a configuration gap an operator closes in one UPDATE, and the
      // buy screen should invite a retry rather than report a crash.
      return errorResponse('no_active_pricing', origin, 'No active star_pricing_config row');
    }

    // NUMERIC(5,2) arrives from PostgREST as the string "11.00", not as 11 —
    // Postgres numerics are serialised as JSON strings to protect precision
    // that a double cannot carry. Coercing here means the client multiplies
    // a number by a number; leaving it would make `stars * price` produce
    // NaN and render every total on the buy screen as "NaN บาท".
    return successResponse(
      {
        retail_thb_per_star: Number(data.retail_thb_per_star),
        label: data.label,
      },
      origin,
    );
  } catch (err) {
    console.error('[wallet-pricing]', err);
    return errorResponse('internal_error', origin);
  }
});
