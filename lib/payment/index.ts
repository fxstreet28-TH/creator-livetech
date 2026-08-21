/**
 * Public API for the payment service layer.
 *
 * Consumers import from '@/lib/payment' and nothing else. Never reach into
 * './providers/stripe' or './checkout' directly — the barrel is the contract,
 * and keeping it the only entry point is what lets provider integration land
 * in later PRs without touching a single component.
 */

export type {
  Currency,
  PaymentProvider,
  SubscriptionTier,
  PpvProduct,
  WalletTopupOption,
  Entitlement,
  CheckoutInput,
  CheckoutSession,
  WebhookEvent,
} from './types';

export { openCheckout, checkoutUrl } from './checkout';

export {
  hasEntitlement,
  getCachedEntitlements,
  setEntitlements,
  clearEntitlements,
} from './entitlement';

export { providers, availableProviders } from './providers';
