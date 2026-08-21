/**
 * OxaPay provider — stub. Real implementation lives in the checkout page
 * (a hosted OxaPay invoice redirect) and the backend webhook handler (Edge Function
 * `oxapay-webhook`). Neither exists yet.
 *
 * The purpose of this file is to make the provider registry (`./index.ts`)
 * compilable and to give a clear place for the eventual OxaPay-specific
 * pre-checkout hooks to land.
 */

import type { PaymentProvider } from '../types';

export const provider: PaymentProvider = 'oxapay';

export function isConfigured(): boolean {
  // No OxaPay merchant token wired up yet.
  return false;
}

/**
 * Hand the caller off to OxaPay. Deliberately unimplemented — the redirect
 * is built on the checkout page, not in the app bundle.
 */
export function createProviderCheckout(): never {
  throw new Error('not_implemented');
}
