/**
 * Stripe plumbing shared by create-payment-intent and stripe-webhook.
 *
 * PromptPay only. It is a push payment: the buyer pushes THB from their
 * own bank app after scanning a QR, so there is no card on file, no
 * chargeback path, and nothing for a dispute webhook to handle. That is
 * the whole reason the Week 3 policy can be markup-buffer-only with no
 * creator reserve — see the buyback_requests comment in
 * migrations/20260827_week3_stripe_promptpay.sql.
 *
 * The SDK runs on Deno through its `worker` export condition: fetch for
 * transport, WebCrypto for signatures, no Node built-ins. Both have to be
 * handed in explicitly — the defaults reach for Node's http and crypto
 * modules, which the Supabase runtime does not provide.
 */

import Stripe from 'stripe';

/** Star metadata written onto every PaymentIntent we create. */
export interface StarPurchaseMetadata {
  user_id: string;
  stars: number;
  retail_thb_per_star: number;
  internal_thb_per_star: number;
  pricing_config_id: string | null;
  source: string;
}

let cached: Stripe | null = null;

/**
 * Stripe client on the live secret key.
 *
 * Cached across invocations of the same isolate: the client is stateless
 * and building one per request re-parses the key and re-allocates the
 * resource tree for nothing.
 *
 * apiVersion is deliberately not pinned here. The SDK pins its own, and
 * the two disagreeing is how a response shape changes under a function
 * that was never redeployed.
 */
export function stripeClient(): Stripe {
  if (cached) return cached;

  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('STRIPE_SECRET_KEY must be set');

  cached = new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),
    appInfo: { name: 'AURUM Live', url: 'https://creatorlivetech.com' },
  });
  return cached;
}

/** WebCrypto signature verifier for constructEventAsync(). */
export function stripeCryptoProvider(): Stripe.CryptoProvider {
  return Stripe.createSubtleCryptoProvider();
}

/**
 * Stripe metadata values are strings, always — an integer round-trips as
 * "500". This turns a PaymentIntent's metadata back into the typed shape
 * the webhook needs, and returns null for anything that is not one of our
 * star purchases.
 *
 * A null here is not an error: the same Stripe account can carry
 * PaymentIntents this code did not create (a `stripe trigger` test event
 * has empty metadata, and any future product would have its own), and
 * those must be ignored rather than half-credited to a parsed-as-NaN user.
 */
export function parseStarMetadata(
  metadata: Stripe.Metadata | null | undefined,
): StarPurchaseMetadata | null {
  if (!metadata) return null;

  const userId = metadata.user_id;
  const stars = Number(metadata.stars);
  if (typeof userId !== 'string' || userId === '') return null;
  if (!Number.isInteger(stars) || stars <= 0) return null;

  const retail = Number(metadata.retail_thb_per_star);
  const internal = Number(metadata.internal_thb_per_star);

  return {
    user_id: userId,
    stars,
    retail_thb_per_star: Number.isFinite(retail) ? retail : 0,
    internal_thb_per_star: Number.isFinite(internal) ? internal : 0,
    pricing_config_id: metadata.pricing_config_id ?? null,
    source: metadata.source ?? 'custom',
  };
}

/**
 * The id of the charge behind a succeeded PaymentIntent.
 *
 * latest_charge is a string when the charge is not expanded and an object
 * when it is; the webhook never expands, but reading it defensively costs
 * one line and survives someone turning expansion on later.
 */
export function latestChargeId(pi: Stripe.PaymentIntent): string | null {
  const charge = pi.latest_charge;
  if (!charge) return null;
  return typeof charge === 'string' ? charge : charge.id;
}
