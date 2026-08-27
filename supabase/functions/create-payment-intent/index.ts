/**
 * create-payment-intent — POST /create-payment-intent (Week 3 Phase B).
 *
 * Prices a star purchase off the live star_pricing_config row, opens a
 * Stripe PromptPay PaymentIntent for it, and hands back the client secret
 * the buy screen renders as a QR.
 *
 * POST { stars, source? }
 *   -> { client_secret, payment_intent_id, stars, amount_thb,
 *        retail_thb_per_star, currency, status }
 *
 * Nothing here credits stars. The buyer scans the QR in their own bank
 * app, Stripe tells us about it, and stripe-webhook does the crediting —
 * this function must never anticipate a payment that has not happened.
 *
 * Deployed with verify_jwt: true, so the platform rejects an unauthenticated
 * call before it reaches this code; getAuthedUser() is what identifies
 * *which* user is buying.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { getAuthedUser } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { stripeClient } from '../_shared/stripe.ts';
import {
  getActivePricing,
  MAX_PURCHASE_STARS,
  MAX_WALLET_STARS,
  MIN_PURCHASE_STARS,
  priceInSatang,
} from '../_shared/stars.ts';

interface CreateIntentBody {
  stars?: unknown;
  source?: unknown;
}

/** Analytics only: did the buyer tap a preset tile or type an amount. */
const SOURCES = new Set(['preset', 'custom']);

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  try {
    const user = await getAuthedUser(req);
    if (!user) return errorResponse('invalid_credentials', origin, 'Missing or invalid bearer token');

    let body: CreateIntentBody;
    try {
      body = await req.json();
    } catch {
      return errorResponse('invalid_input', origin, 'Body must be JSON');
    }

    const stars = body.stars;
    if (typeof stars !== 'number' || !Number.isInteger(stars)) {
      return errorResponse('invalid_amount', origin, 'stars must be an integer');
    }
    if (stars < MIN_PURCHASE_STARS || stars > MAX_PURCHASE_STARS) {
      return errorResponse(
        'invalid_amount',
        origin,
        `stars must be between ${MIN_PURCHASE_STARS} and ${MAX_PURCHASE_STARS}`,
      );
    }

    const source = typeof body.source === 'string' && SOURCES.has(body.source) ? body.source : 'custom';

    const supabase = serviceClient();

    // A signed-in user without a customers row is mid-signup or a creator
    // account that never got one. Selling them stars would credit a wallet
    // the rest of the system does not consider a buyer.
    const { data: customer, error: customerErr } = await supabase
      .from('customers')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (customerErr) {
      console.error('[create-payment-intent] customer lookup failed', customerErr);
      return errorResponse('internal_error', origin, 'Customer lookup failed');
    }
    if (!customer) return errorResponse('not_customer', origin, 'No customers row for this user');

    const { pricing, error: pricingErr } = await getActivePricing(supabase);
    if (!pricing) {
      console.error('[create-payment-intent] no active pricing', pricingErr);
      return errorResponse('no_active_pricing', origin, pricingErr);
    }

    // The wallet cap is enforced by credit_stars_purchase, which runs
    // *after* the money has arrived. Checking it here is what stops a buyer
    // paying for stars the webhook would then have to refuse — and with no
    // refund path (buyback only), that is not a recoverable state.
    const { data: wallet, error: walletErr } = await supabase
      .from('stars_wallet')
      .select('total_balance')
      .eq('user_id', user.id)
      .maybeSingle();

    if (walletErr) {
      console.error('[create-payment-intent] wallet lookup failed', walletErr);
      return errorResponse('internal_error', origin, 'Wallet lookup failed');
    }

    const balance = wallet?.total_balance ?? 0;
    if (balance + stars > MAX_WALLET_STARS) {
      return errorResponse(
        'wallet_cap_exceeded',
        origin,
        `balance ${balance} + ${stars} would exceed the ${MAX_WALLET_STARS} star wallet limit`,
      );
    }

    const { amountSatang, amountThb } = priceInSatang(stars, pricing.retail_thb_per_star);

    const stripe = stripeClient();

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountSatang,
        currency: 'thb',
        payment_method_types: ['promptpay'],
        description: `${stars} stars for AURUM Live`,
        // Metadata is what the webhook credits from. It is written here,
        // at the only point where the buyer's identity and the price they
        // were quoted are both known, and Stripe returns it verbatim on
        // every event about this intent — so a webhook delivery is
        // self-describing even if our own bookkeeping row is missing.
        metadata: {
          user_id: user.id,
          stars: stars.toString(),
          retail_thb_per_star: pricing.retail_thb_per_star.toString(),
          internal_thb_per_star: pricing.internal_thb_per_star.toString(),
          pricing_config_id: pricing.id,
          source,
        },
      });
    } catch (err) {
      console.error('[create-payment-intent] stripe create failed', err);
      return errorResponse('stripe_error', origin, 'PaymentIntent creation failed');
    }

    const { error: intentErr } = await supabase.from('star_payment_intents').insert({
      stripe_payment_intent_id: paymentIntent.id,
      user_id: user.id,
      stars,
      retail_thb_per_star: pricing.retail_thb_per_star,
      internal_thb_per_star: pricing.internal_thb_per_star,
      amount_thb: amountThb,
      amount_satang: amountSatang,
      currency: 'thb',
      pricing_config_id: pricing.id,
      source,
      status: 'pending',
    });

    if (intentErr) {
      // The intent exists at Stripe but we have nowhere to track it. Cancel
      // it rather than hand back a QR: an uncancelled one could be paid,
      // and while the webhook would still credit correctly from metadata,
      // it would do so against a purchase this side never recorded opening.
      console.error('[create-payment-intent] intent row insert failed', intentErr);
      try {
        await stripe.paymentIntents.cancel(paymentIntent.id);
      } catch (cancelErr) {
        // Logged, not raised: the credit path does not depend on this row,
        // so a live intent here is recoverable — a silent 500 is not.
        console.error('[create-payment-intent] orphan intent cancel failed', paymentIntent.id, cancelErr);
      }
      return errorResponse('internal_error', origin, 'Could not record the payment intent');
    }

    return successResponse(
      {
        client_secret: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        stars,
        amount_thb: amountThb,
        retail_thb_per_star: pricing.retail_thb_per_star,
        currency: 'thb',
        status: 'pending',
      },
      origin,
    );
  } catch (err) {
    console.error('[create-payment-intent] unhandled', err);
    return errorResponse('internal_error', origin);
  }
});
