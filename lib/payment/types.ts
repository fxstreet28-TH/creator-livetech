/**
 * Payment types shared across the payment service layer.
 *
 * All string IDs are Supabase-generated UUIDs unless noted. Prices are
 * expressed in the smallest currency unit (satang for THB, cents for USD)
 * to avoid floating-point rounding — display layer converts to major units.
 */

export type Currency = 'THB' | 'USD';

export type PaymentProvider = 'stripe' | 'promptpay' | 'oxapay';

/**
 * A monthly subscription tier a creator offers to their followers.
 * Fanvue analogue: subscription plan.
 */
export interface SubscriptionTier {
  id: string;
  creatorId: string;
  name: string;                    // e.g. 'Gold', 'ทองคำ'
  priceMonthly: number;            // in smallest currency unit
  currency: Currency;
  benefitsMd: string;              // markdown, rendered on checkout + profile
  createdAt: string;               // ISO timestamp
}

/**
 * A one-time paywalled content unlock (PPV post, replay, private video).
 */
export interface PpvProduct {
  id: string;
  creatorId: string;
  contentId: string;               // FK to posts/videos/etc.
  price: number;
  currency: Currency;
  createdAt: string;
}

/**
 * A wallet top-up amount preset (for the wallet feature).
 */
export interface WalletTopupOption {
  amount: number;
  currency: Currency;
}

/**
 * A single active entitlement for a user. Either a subscription (recurring)
 * or a one-time unlock (ppv, wallet credit).
 */
export interface Entitlement {
  id: string;
  userId: string;
  kind: 'subscription' | 'ppv' | 'wallet_credit';
  refId: string;                   // subscriptionTierId, ppvProductId, or 'wallet'
  status: 'active' | 'past_due' | 'cancelled' | 'expired';
  currentPeriodEnd: string | null; // null for one-time unlocks
  createdAt: string;
}

/**
 * Input to openCheckout(). The client says "buy this thing" — provider
 * selection happens at the checkout page based on what the user picks.
 */
export type CheckoutInput =
  | { kind: 'subscription'; tierId: string }
  | { kind: 'ppv'; productId: string }
  | { kind: 'wallet_topup'; amount: number; currency: Currency };

/**
 * Result of a checkout session request from the backend. The url is what
 * openCheckout() opens in a native browser sheet or full-page nav.
 */
export interface CheckoutSession {
  sessionId: string;
  url: string;                     // the /checkout page URL with session token
  expiresAt: string;               // ISO — sessions expire fast, ~30 min
}

/**
 * Shape of the webhook events providers send us. Not consumed in this PR
 * (the receiver Edge Function is a later PR) but typed here so it's shared
 * across the abstraction.
 */
export interface WebhookEvent<TPayload = unknown> {
  provider: PaymentProvider;
  eventId: string;                 // provider's own event ID for idempotency
  eventType: string;               // provider-specific, e.g. 'charge.succeeded'
  receivedAt: string;
  payload: TPayload;
}
