/**
 * Provider registry.
 *
 * Every provider module exports the same two markers: which provider it is,
 * and whether its credentials are wired up. The checkout page uses
 * availableProviders() to decide which payment methods to render.
 *
 * Not part of the public API — consumers import from '@/lib/payment', which
 * re-exports what they need.
 */

import * as stripe from './stripe';
import * as promptpay from './promptpay';
import * as oxapay from './oxapay';
import type { PaymentProvider } from '../types';

interface ProviderModule {
  provider: PaymentProvider;
  isConfigured(): boolean;
}

export const providers: Record<PaymentProvider, ProviderModule> = {
  stripe,
  promptpay,
  oxapay,
};

/**
 * Providers whose credentials are wired up. Empty today — every provider is
 * still a stub. The checkout page (later PR) renders one payment-method
 * option per entry.
 */
export function availableProviders(): PaymentProvider[] {
  return (Object.keys(providers) as PaymentProvider[]).filter(
    (p) => providers[p].isConfigured(),
  );
}
