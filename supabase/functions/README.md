# Supabase Edge Functions

This directory holds the Deno code that will take over from the Next.js API
routes under `app/api/auth/*`. Those routes are the last thing standing between
us and a working Capacitor build: they need a Node server at runtime, and a
static mobile bundle has nowhere to put one. See
`docs/capacitor-audit.md` § P0 #3 for the full reasoning.

## What is here right now

Only `_shared/` — a set of utilities that the real functions will import. There
are **no deployed functions yet**, and nothing in the app calls any of this
code. The Next.js routes are still serving every request in production exactly
as before.

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
| `MOVIDER_API_KEY`, `MOVIDER_API_SECRET` | `_shared/movider.ts` | Form-encoded credentials, not a Bearer token. |
| `MOVIDER_SENDER_NAME` | `_shared/movider.ts` | Optional. Leave unset while the "AURUM" sender ID is unapproved for Thailand — Movider then falls back to a numeric sender and the SMS still arrive. |
| `RESEND_API_KEY` | `_shared/resend.ts` | |
| `RESEND_FROM_EMAIL` | `_shared/resend.ts` | Includes the display name: `AURUM Live <no-reply@creatorlivetech.com>`. |

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

`_shared/otp.ts` deserves particular care. It has to produce the same HMAC
digests and the same AES-256-GCM ciphertexts as `lib/otp.ts`, because both
implementations read and write the same rows in `phone_otps`, `email_codes`,
and `signup_sessions`. If they ever disagree, users mid-signup at deploy time
fail at the verification step. The compatibility was checked in both directions
when the file was written; re-check it if you touch the crypto.

## What comes next

PR 5b builds `init-signup` and `resend-code` on top of these utilities and
deploys them. PR 5c does `complete-signup` and `check-availability`, and deletes
`app/api/auth/login/`. Until then, everything here is dormant.
