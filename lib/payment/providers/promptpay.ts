/**
 * INET PromptPay provider — stub. Real implementation lives in the checkout page
 * (a server-rendered PromptPay QR) and the backend webhook handler (Edge Function
 * `promptpay-webhook`). Neither exists yet.
 *
 * The purpose of this file is to make the provider registry (`./index.ts`)
 * compilable and to give a clear place for the eventual INET PromptPay-specific
 * pre-checkout hooks to land.
 */

import type { PaymentProvider } from '../types';

export const provider: PaymentProvider = 'promptpay';

export function isConfigured(): boolean {
  // No INET merchant credentials wired up yet.
  return false;
}

/**
 * Hand the caller off to INET PromptPay. Deliberately unimplemented — the redirect
 * is built on the checkout page, not in the app bundle.
 */
export function createProviderCheckout(): never {
  throw new Error('not_implemented');
}
