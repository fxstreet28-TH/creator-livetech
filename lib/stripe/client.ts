'use client';

/**
 * Stripe.js loader for the star purchase flow.
 *
 * Singleton for the same reason lib/supabase-browser.ts is one: loadStripe()
 * injects a <script> tag and resolves a Stripe object bound to it. Calling it
 * per render would inject the script repeatedly and hand different components
 * different Stripe instances.
 *
 * The publishable key is the only Stripe credential that belongs in a browser
 * bundle. It can create and confirm PaymentIntents the caller already holds a
 * client_secret for, and nothing else — no reads, no refunds, no customer
 * data. The secret key lives in the Edge Function environment and must never
 * appear here.
 */

import { loadStripe, type Stripe } from '@stripe/stripe-js';

/**
 * Baked in at build time, like every NEXT_PUBLIC_* value. A missing key in
 * the mobile bundle cannot be fixed without a store re-release, so the
 * absence is reported rather than thrown past: see getStripe().
 */
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

let stripePromise: Promise<Stripe | null> | null = null;

/** True when the build carries a publishable key at all. */
export function isStripeConfigured(): boolean {
  return typeof PUBLISHABLE_KEY === 'string' && PUBLISHABLE_KEY.length > 0;
}

/**
 * The shared Stripe.js instance, or null when the key is missing or the
 * script could not load (offline, blocked by a content blocker).
 *
 * Deliberately does not throw. A buy screen that crashes on mount tells the
 * user nothing; the caller checks for null and renders a Thai error instead.
 */
export function getStripe(): Promise<Stripe | null> {
  if (!isStripeConfigured()) return Promise.resolve(null);
  if (!stripePromise) {
    stripePromise = loadStripe(PUBLISHABLE_KEY as string).catch((err) => {
      // Reset so a later attempt can retry the script load rather than
      // resolving this same rejected promise forever.
      console.error('[stripe] failed to load Stripe.js', err);
      stripePromise = null;
      return null;
    });
  }
  return stripePromise;
}
