# Supabase Edge Functions

This directory holds the Deno code that will take over from the Next.js API
routes under `app/api/auth/*`. Those routes are the last thing standing between
us and a working Capacitor build: they need a Node server at runtime, and a
static mobile bundle has nowhere to put one. See
`docs/capacitor-audit.md` § P0 #3 for the full reasoning.

## What is here right now

`_shared/` — a set of utilities the functions import — plus three deployed
functions: `init-signup` and `resend-code` (PR 5b) and `complete-signup`
(PR 5c). The signup flow calls all three. `app/api/auth/complete-signup/` is
still deployed on Vercel but no longer referenced by anything: it is the
one-`git revert`-away fallback for the 24h soak, and PR 5c part 2 deletes it.
`app/api/auth/login/` and `app/api/auth/check-availability/` are untouched and
still serving.

| File | What it does |
| --- | --- |
| `_shared/cors.ts` | CORS headers for the web origin, Vercel previews, and the two Capacitor origins. Whitelist, not wildcard. |
| `_shared/errors.ts` | `errorResponse()` / `successResponse()` — JSON envelopes with a machine-readable code and a Thai message. |
| `_shared/supabase.ts` | `serviceClient()` — service-role Supabase client. Bypasses RLS. |
| `_shared/auth.ts` | `getAuthedUser()` — verifies the caller's JWT for functions that require a signed-in user. |
| `_shared/rate-limit.ts` | `checkRateLimit()` against the `auth_rate_limits` ledger table. |
| `_shared/otp.ts` | OTP hashing (HMAC-SHA256) and AES-256-GCM password crypto for signup sessions. |
| `_shared/movider.ts` | `sendSms()` — SMS OTP via Movider. |
| `_shared/resend.ts` | `sendEmailVerificationCode()` — email OTP via Resend. |
| `_shared/stars.ts` | Star wallet helpers over the money RPCs, plus `getActivePricing()` and `priceInSatang()`. |
| `_shared/stripe.ts` | Stripe client on the SDK's `worker` build, PaymentIntent metadata parsing. |

| Function | What it does |
| --- | --- |
| `init-signup/` | Creates the signup session, issues + sends both codes. |
| `resend-code/` | Re-issues one channel's code for an existing session. |
| `complete-signup/` | Verifies both codes, creates the `auth.users` row, seeds `customers` + `creators`, mints session tokens, deletes the session. |
| `create-payment-intent/` | Prices a star purchase off `star_pricing_config` and opens a Stripe PromptPay PaymentIntent. Credits nothing. |
| `stripe-webhook/` | The only path that credits stars for money. Verifies Stripe's signature, records the delivery in `stripe_events`, calls `credit_stars_purchase`. **Deploy with `--no-verify-jwt`.** |
| `buyback-request/` | Star cashout at a flat 3.00 THB/star. Deducts now, pays by hand later. |
| `wallet-pricing/` | Returns the live `star_pricing_config` row to the buy screen. Selects `retail_thb_per_star` and `label` only — `internal_thb_per_star` is the creator-payout basis and must never reach a browser. |

All three keep the request/response shapes, error codes and HTTP statuses of
the Next.js routes they replace byte-for-byte — `components/auth/steps/` maps
those codes to Thai copy, and an unchanged wire format is what makes a revert
of the frontend commit a clean fallback to the still-deployed Vercel route.

Each of these is a port of its `lib/*.ts` counterpart, kept deliberately
close to the original so the two implementations can run side by side during
the migration without behaving differently.

## Getting set up

Install the Supabase CLI (needs version 1.180.0 or newer):

```bash
brew install supabase/tap/supabase    # macOS
supabase --version
```

Other platforms are covered at https://supabase.com/docs/guides/cli/getting-started.

Then link this repo to the Supabase project. You only ever do this once per
machine:

```bash
supabase link --project-ref hknvooaqgpufrbdxtzxf
```

The first run asks for an access token — generate one at
https://supabase.com/dashboard/account/tokens with read + write scope.

## Running a function locally

```bash
supabase functions serve
```

That serves everything in this directory at `http://localhost:54321/functions/v1/<name>`
and reloads on save. Local runs read secrets from `supabase/.env.local`, which
is gitignored and which you create yourself — it is not the same file Next.js
reads. Copy the values you need out of Vercel.

## Deploying

```bash
supabase functions deploy <name>
```

`stripe-webhook` is the one exception to that line, and forgetting it is the
whole difference between a working endpoint and one that 401s every delivery:

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

Stripe signs its requests with `stripe-signature`, not with a Supabase JWT, so
the platform's JWT gate would reject every event before the function ran. What
takes its place is inside the function: the signature is verified before
anything is read out of the body, and every delivery is claimed in
`stripe_events` under Stripe's own event id, so a redelivery cannot credit a
payment twice. There is no `config.toml` in this repo, so the flag lives here
and on the command line rather than in a file — check it before every deploy of
that function.

Deployment is **manual, from your machine**. There is no GitHub Action for it
and that is on purpose: this Supabase project is deliberately not
GitHub-integrated, so nothing deploys to it as a side effect of merging a PR.
The trade is that a merged PR does not ship the function — you have to run the
deploy yourself, and that step is easy to forget. When a PR changes anything
under `supabase/functions/`, deploying is part of merging it.

## Secrets

Edge Functions do not see Vercel's environment variables. They have their own
store, set through the CLI:

```bash
supabase secrets set MOVIDER_API_KEY=... MOVIDER_API_SECRET=...
supabase secrets list
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are the exception — the runtime
injects those automatically, so never set them by hand.

Everything else has to be copied over from Vercel before the function that
needs it goes live:

| Secret | Needed by | Notes |
| --- | --- | --- |
| `OTP_HMAC_SECRET` | `_shared/otp.ts` | Must be byte-identical to the Vercel value, or codes issued by the old routes stop verifying. |
| `SESSION_ENCRYPTION_KEY` | `_shared/otp.ts` | Same — 64 hex chars. A mismatch makes in-flight signup sessions undecryptable. |
| `SUPABASE_ANON_KEY` | `_shared/supabase.ts` `anonClient()` | Injected by the runtime like the two above — never set it by hand. `complete-signup` signs the new user in with it to mint session tokens. |
| `MOVIDER_API_KEY`, `MOVIDER_API_SECRET` | `_shared/movider.ts` | Form-encoded credentials, not a Bearer token. |
| `MOVIDER_SENDER_NAME` | `_shared/movider.ts` | Optional. Leave unset while the "AURUM" sender ID is unapproved for Thailand — Movider then falls back to a numeric sender and the SMS still arrive. |
| `RESEND_API_KEY` | `_shared/resend.ts` | |
| `RESEND_FROM_EMAIL` | `_shared/resend.ts` | Includes the display name: `AURUM Live <no-reply@creatorlivetech.com>`. |
| `STRIPE_SECRET_KEY` | `_shared/stripe.ts` | `sk_live_...`, LIVE mode. Week 3 sells real stars for real THB; a test key here makes every QR unpayable. |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook/` | `whsec_...`, from the webhook endpoint's own page in the Stripe dashboard — not the API key, and specific to that one endpoint. Rotating the endpoint changes it. |

## Working on this code

Edge Functions run on Deno, not Node. Imports are URLs or `npm:` specifiers,
`process.env` is `Deno.env.get()`, there is no `Buffer` and no `require()`.
Node's built-in modules are unavailable — the Supabase runtime disables them —
so `node:crypto` is out and Web Crypto (`crypto.subtle`) is in. That constraint
is the reason `_shared/otp.ts` exists as a separate file rather than importing
`lib/otp.ts`.

Type-check before committing:

```bash
cd supabase/functions && deno task check
```

And run the unit tests, which cover the parts of the money path that need no
database or Stripe key — what a buyer is charged, and who a webhook credits:

```bash
cd supabase/functions && deno task test
```

`_shared/otp.ts` deserves particular care. It has to produce the same HMAC
digests and the same AES-256-GCM ciphertexts as `lib/otp.ts`, because both
implementations read and write the same rows in `phone_otps`, `email_codes`,
and `signup_sessions`. If they ever disagree, users mid-signup at deploy time
fail at the verification step. The compatibility was checked in both directions
when the file was written; re-check it if you touch the crypto.

## What comes next

PR 5c part 2 deletes `app/api/auth/complete-signup/route.ts` once the Edge
Function has soaked on production for 24h. PR 5d migrates `/api/auth/login`
using the same phase A/B/C structure — it was deliberately kept out of PR 5c so
a login regression and a signup regression could never be in flight together.
`check-availability` becomes a `SECURITY DEFINER` RPC rather than a function.
