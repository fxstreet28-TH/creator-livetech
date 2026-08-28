'use client';

/**
 * Reading the PromptPay QR out of a confirmed PaymentIntent.
 *
 * @stripe/stripe-js types `PaymentIntent.next_action` as a closed union that
 * enumerates redirect_to_url, use_stripe_sdk, wechat_pay_display_qr_code and
 * verify_with_microdeposits — and not promptpay_display_qr_code, even though
 * the API returns it. So the field cannot be reached through the published
 * types at all, and the choice is between a bare `as any` at the call site or
 * one narrowing function that checks the shape it claims. This is that
 * function: the cast is confined here, and it is followed by a real runtime
 * check, so a future Stripe response that drops or renames the field
 * surfaces as a handled error rather than as `undefined.image_url_png`.
 */

import type { PaymentIntent } from '@stripe/stripe-js';

export interface PromptPayQrCode {
  /** Stripe-hosted PNG. Rendered directly; never re-encoded locally. */
  imageUrlPng: string;
  /** Stripe-hosted payment page. Copy-link and open-in-bank-app target. */
  hostedInstructionsUrl: string | null;
  /** Epoch milliseconds. Stripe's own expiry when it sends one. */
  expiresAt: number | null;
}

/** Stripe sends `expires_at` in seconds, like every other API timestamp. */
function toEpochMs(seconds: unknown): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Pull the QR out of a PaymentIntent, or return null if it is not there —
 * which is the normal answer for an intent that is already succeeded, was
 * canceled, or failed before reaching next_action.
 */
export function extractPromptPayQr(intent: PaymentIntent | undefined | null): PromptPayQrCode | null {
  if (!intent?.next_action) return null;

  const qr = (intent.next_action as unknown as Record<string, unknown>)
    .promptpay_display_qr_code as Record<string, unknown> | undefined;

  if (!qr || typeof qr.image_url_png !== 'string' || qr.image_url_png === '') return null;

  return {
    imageUrlPng: qr.image_url_png,
    hostedInstructionsUrl:
      typeof qr.hosted_instructions_url === 'string' && qr.hosted_instructions_url !== ''
        ? qr.hosted_instructions_url
        : null,
    expiresAt: toEpochMs(qr.expires_at),
  };
}

/**
 * How long a PromptPay QR is good for when Stripe does not say.
 *
 * Stripe's documented default is ten minutes. Taking it as a local fallback
 * rather than the source of truth matters: if the real deadline is shorter
 * than what the screen counts down, the buyer scans a dead QR and is told
 * nothing. `expires_at` from the response always wins.
 */
export const PROMPTPAY_DEFAULT_TTL_MS = 10 * 60 * 1000;
