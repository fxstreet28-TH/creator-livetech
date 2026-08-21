'use client';

/**
 * Open a checkout session in the appropriate context.
 *
 * Native (Capacitor): opens Browser.open() — a system in-app browser sheet.
 *   User can dismiss with a swipe and returns to the app in the same state.
 *
 * Web: full-page navigation to the checkout URL. Back button works normally.
 *
 * Flow:
 *   1. Client calls openCheckout({ kind, ... }).
 *   2. This function POSTs to the backend to create a CheckoutSession.
 *   3. Backend returns { url, sessionId, expiresAt }.
 *   4. Client opens that URL according to runtime.
 *   5. On the checkout page, user picks Stripe / PromptPay / OxaPay.
 *   6. Provider fires webhook to backend → entitlement flips server-side.
 *   7. On next app foreground, entitlement cache invalidates and refetches.
 */

import { Browser } from '@capacitor/browser';
import { apiUrl, isNative, APP_WEB_URL } from '@/lib/config';
import type { CheckoutInput, CheckoutSession } from './types';

export async function openCheckout(input: CheckoutInput): Promise<void> {
  const session = await createCheckoutSession(input);

  if (isNative()) {
    await Browser.open({
      url: session.url,
      presentationStyle: 'popover',   // iOS sheet; Android uses fullscreen
      windowName: '_self',
    });
    return;
  }

  // Web — full-page nav. Same-origin so cookies/localStorage carry over on return.
  window.location.href = session.url;
}

async function createCheckoutSession(input: CheckoutInput): Promise<CheckoutSession> {
  // Backend endpoint doesn't exist yet — PR 9 (checkout page + webhook) adds it.
  // Until then, this call fails at runtime. Which is fine, because nothing
  // calls openCheckout() yet either.
  const res = await fetch(apiUrl('/api/checkout/session'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body: { message?: string } = await res.json().catch(() => ({}));
    throw new Error(body.message ?? 'Failed to create checkout session');
  }

  return res.json() as Promise<CheckoutSession>;
}

/**
 * Build a URL to the checkout page directly (for cases where the caller
 * already has the session ID from elsewhere — e.g. a resumption deep link
 * from an email).
 */
export function checkoutUrl(sessionId: string): string {
  return `${APP_WEB_URL}/checkout/${encodeURIComponent(sessionId)}`;
}
