# `lib/payment` — payment service layer

This folder is the abstraction every monetization feature in creator-livetech
goes through: subscription tiers, PPV unlocks, DM tips, wallet top-ups. It
exists so that provider-specific code (Stripe, INET PromptPay, OxaPay) never
leaks into a component, a page, or a button handler.

Today it is scaffold. The types are real, the two runtime helpers
(`openCheckout`, `hasEntitlement`) are real, and the three providers are stubs
that throw `not_implemented`. Nothing in the app imports this module yet — the
first consumer is the checkout page PR. Landing the shape first is deliberate:
see `docs/capacitor-audit.md` § "Payment abstraction" for the reasoning.

## The web-checkout, app-view pattern

The mobile app never handles payment itself. Every purchase — from a native
Capacitor shell or from the web — opens the same URL at
`creatorlivetech.com/checkout`. The web page renders the payment UI, the
provider fires a webhook at our backend, the backend flips the entitlement
server-side, and the app picks up the change on its next foreground.

Two reasons this is the right shape:

**No store commission.** Apple and Google take 15–30% of any digital-goods
purchase that happens inside an app binary. A purchase completed in a system
browser sheet, on a website the user navigates to, is not that. This is the
same pattern Netflix, Spotify, and Fanvue use, and it is the difference between
keeping 100% and keeping 70% of subscription revenue.

**One code path.** Web and mobile share the checkout page, the provider
integrations, and the webhook handlers. Adding a fourth provider means changing
the checkout page — not shipping a new app build through store review.

`openCheckout()` is what makes this a single call site. On native it opens
`Browser.open()` from `@capacitor/browser`, which presents a system in-app
browser sheet the user can dismiss with a swipe, returning to the app in the
same state. On web it does a full-page navigation to the same URL, so the back
button works and there is no popup blocker to fight. Callers do not care which
of those happened.

## Using it

Import from `'@/lib/payment'` and nowhere else. The barrel (`index.ts`) is the
API surface; reaching into `lib/payment/providers/stripe` directly defeats the
whole point.

Starting a purchase from a component:

```tsx
'use client';

import { openCheckout } from '@/lib/payment';

export function SubscribeButton({ tierId }: { tierId: string }) {
  return (
    <button onClick={() => openCheckout({ kind: 'subscription', tierId })}>
      สมัครสมาชิก
    </button>
  );
}
```

Rendering a locked/unlocked state optimistically:

```tsx
import { hasEntitlement } from '@/lib/payment';

const unlocked = hasEntitlement(userId, 'subscription', tierId);
return unlocked ? <PremiumFeed /> : <Paywall tierId={tierId} />;
```

Note what the caller does *not* pass: a provider. `openCheckout()` says "buy
this thing" and stops there.

## How a provider gets chosen

Provider selection happens at the checkout page, not at the button. When the
page loads it calls `availableProviders()` to find which integrations have
credentials wired up, renders one payment-method option per entry, and the user
picks — international card via Stripe, Thai bank transfer via PromptPay QR, or
crypto via OxaPay. The app bundle stays ignorant of all three.

`availableProviders()` returns an empty array today, because every provider
stub reports `isConfigured() === false`. That is expected, not a bug.

## Where the real work happens

Nothing in this folder talks to a payment API. The pieces that will:

- **`/checkout/[sessionId]`** — the web checkout page. Renders the payment
  method picker and drives the provider's client SDK. Upcoming PR.
- **`/api/checkout/session`** — creates a `CheckoutSession` and returns its
  URL. Does not exist yet, which is why `openCheckout()` 404s if you call it
  today. Same upcoming PR.
- **`stripe-webhook` / `promptpay-webhook` / `oxapay-webhook`** — Supabase Edge
  Functions that receive provider callbacks, verify signatures, dedupe on
  `WebhookEvent.eventId`, and write entitlements. One PR per provider.
- **`entitlements` table + RLS** — the actual source of truth. Migration comes
  with the first real subscribe PR, not this one.

## Security notes

**`hasEntitlement()` is a UX cache, never a boundary.** It reads an in-memory
map that the client populated. A determined user can make it return whatever
they want. Use it to avoid a flash of "locked" state on a fast render, and
nothing else. Premium content must be fetched from Supabase, where RLS policies
on the `entitlements` table decide whether rows come back at all. If the client
cache is wrong, the worst outcome is a brief wrong render followed by the truth.

**Provider secrets never reach the client.** Stripe's secret key, OxaPay's
merchant token, and INET's credentials are Supabase Edge Function secrets, set
server-side. The only payment-related value that may live in a `NEXT_PUBLIC_*`
variable is the checkout URL host (`NEXT_PUBLIC_APP_WEB_URL`, already in
`lib/config.ts`). If you find yourself adding `NEXT_PUBLIC_STRIPE_SECRET`,
stop — you are in the wrong file.

**Prices are integers in the smallest currency unit** — satang for THB, cents
for USD. Never floats. Money math in floating point is one of the most reliable
sources of ecommerce bugs, and the display layer is the only place that divides.

## Adding a fourth provider

Say you want to add TrueMoney. Four steps, in this order:

1. Add `'truemoney'` to the `PaymentProvider` union in `types.ts`. TypeScript
   will immediately fail on the `providers` record in `providers/index.ts`,
   which is the point — the registry is exhaustive by construction.
2. Copy `providers/stripe.ts` to `providers/truemoney.ts`, change the `provider`
   constant, and leave `isConfigured()` returning `false` until credentials
   exist.
3. Register it in `providers/index.ts`. That satisfies the compiler and makes
   the provider visible to `availableProviders()` once configured.
4. Implement the actual integration in the checkout page, and add a
   `truemoney-webhook` Edge Function that writes to `entitlements`. Flip
   `isConfigured()` to check for the real key when the credentials land.

Notice what is not on that list: no component changes, no new app build, no
store review. That is the whole reason this abstraction exists.
