/**
 * Stripe provider — stub. Real implementation lives in the checkout page
 * (client-side Stripe.js) and the backend webhook handler (Edge Function
 * `stripe-webhook`). Neither exists yet.
 *
 * The purpose of this file is to make the provider registry (`./index.ts`)
 * compilable and to give a clear place for the eventual Stripe-specific
 * pre-checkout hooks to land.
 */

import type { PaymentProvider } from '../types';

export const provider: PaymentProvider = 'stripe';

export function isConfigured(): boolean {
  // No Stripe publishable key wired up yet.
  return false;
}

/**
 * Hand the caller off to Stripe. Deliberately unimplemented — the redirect
 * is built on the checkout page, not in the app bundle.
 */
export function createProviderCheckout(): never {
  throw new Error('not_implemented');
}
