# Capacitor Readiness Audit — creator-livetech

Generated: 2026-08-20T10:23:40Z
Commit: `bf81e322cbbd861e7ce20bd5acc419d70b666470`
Scope: full repo scan, read-only. No application code was modified.

## Executive summary

- **Total blockers found: 36** (P0: 9, P1: 11, P2: 16)
- **Estimated refactor effort:**
  - P0 — **L**. The whole authentication backend (5 route handlers + middleware + cookie session) has to move off Next.js server runtime. This is the bulk of the work.
  - P1 — **M**. Mechanical but touches many call sites: image loader, API base URL, Supabase client unification.
  - P2 — **S/M**. Safe-area + touch-target pass, plus the desktop-first landing CSS which is cosmetic-only for the app shell.
- **Verdict: SIGNIFICANT REFACTOR**

Why not MAJOR: the codebase is small (≈30 source files), has **zero** Pages Router code, **zero** `getServerSideProps`/`getInitialProps`, **zero** dynamic `[param]` routes, and **zero** payment code to untangle. Almost all UI is already client components or trivially convertible. The blocking surface is concentrated in one place — `app/api/auth/**` + `middleware.ts` + `lib/session.ts` — and that surface has a clean one-to-one migration target in Supabase Edge Functions.

Why not MINOR: `next build` with `output: 'export'` **will fail today**. Route handlers with `dynamic = 'force-dynamic'`, `cookies()` in server components, and the default `next/image` loader are all hard build errors, not warnings. There is also no environment-driven app URL anywhere in the repo, so the "Web Checkout, App View" pattern has no seam to hook into yet.

### Blocker count by area

| Area | P0 | P1 | P2 |
|---|---|---|---|
| API routes / server runtime | 5 | 2 | — |
| Middleware & session model | 1 | 2 | — |
| Server Components | 2 | — | — |
| Build config | 1 | — | — |
| Images & fonts | — | 3 | 1 |
| URLs & networking | — | 4 | 3 |
| Mobile UX | — | — | 12 |

---

## Current next.config

`next.config.ts` — verbatim, complete file:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
```

**Flags:**

- ❌ **No `output: 'export'`.** Nothing about the current build produces a static bundle. This must be added (ideally behind an env flag so the Vercel web build and the Capacitor build can share one config).
- ❌ **No `images.unoptimized: true` and no custom `images.loader`.** With `output: 'export'`, the default `next/image` loader is a build-time error: *"Image Optimization using the default loader is not compatible with `output: 'export'`"*. There are 2 `<Image />` usages (see P1 §7).
- ⚠️ **No `trailingSlash: true`.** Not a build error, but without it the static export emits `/login.html` rather than `/login/index.html`. Capacitor's `WebViewLocalServer` serves from the filesystem and resolves directory-style paths far more reliably; deep links to `/dashboard` will 404 in the shell without this.
- ⚠️ **No `distDir` / output-dir split.** Capacitor's `webDir` needs to point at `out/`. `.gitignore:6` already ignores `/out/`, so nothing conflicts — but the Capacitor config does not exist yet.
- ✅ No `rewrites`, `redirects`, `headers`, `images.domains`, or `experimental` server flags present. Nothing to remove — the conflict is entirely what's *missing*, not what's there.

**Note on remote images:** `lib/mockData.ts:37` builds DiceBear avatar URLs (`https://api.dicebear.com/...`). These are rendered through a plain `<img>` in `components/dashboard/Avatar.tsx:25`, deliberately (see the comment on `Avatar.tsx:23`), so no `images.remotePatterns` entry is needed. Do **not** "fix" that to `next/image` — the current code is already the Capacitor-correct choice.

---

## Findings

### P0 — Hard blockers

#### 1. `getServerSideProps` / `getInitialProps` usage

**None.** Repo-wide grep for `getServerSideProps`, `getInitialProps`, and `getStaticProps` across all `.ts`/`.tsx` files returns zero hits. There is no `pages/` directory at all — this is a pure App Router project.

✅ Nothing to do here.

#### 2. Server Components with server-only code

Two files. Both are async Server Components that transitively call `cookies()` from `next/headers`, which forces dynamic rendering and fails `output: 'export'` with *"Route couldn't be rendered statically because it used `cookies`"*.

- `app/dashboard/layout.tsx:10` — `const user = await getDashboardUser();` inside `async function DashboardLayout`. This is the root layout for every `/dashboard/*` route.
- `app/dashboard/page.tsx:9` — `const user = await getDashboardUser();` inside `async function DashboardPage`. Second call in the same request (deduped by React `cache`, but still dynamic).

The shared root cause:

- `lib/session.ts:3` — `import { cookies } from 'next/headers';`
- `lib/session.ts:20` — `const cookieStore = await cookies();`
- `lib/session.ts:18` — `getDashboardUser` is wrapped in React `cache()`, which is a server-render-scoped primitive; it has no meaning in a static bundle.

Everything else under `app/` is safe: `app/page.tsx`, `app/explore/page.tsx`, `app/creator/apply/page.tsx`, `app/onboarding/page.tsx`, `app/discover|following|live|messages|settings|subscriptions|wallet/page.tsx` are all pure-render server components with no server-only work, and `app/login/page.tsx:1` is already `"use client"`.

**Migration target:** delete `lib/session.ts` entirely. Move the display-name/avatar derivation into a client hook backed by `supabase.auth.getSession()` (returns from the Supabase client's own storage adapter — no network, no cookies), and pass the result into `DashboardShell` (already a client component, `components/dashboard/DashboardShell.tsx:1`). `HeroWelcome` (`components/dashboard/HeroWelcome.tsx:10`) currently takes `displayName` as a prop, so it needs no change beyond who supplies the prop.

#### 3. API routes

All five live under `app/api/auth/**`. Every one declares `export const runtime = 'nodejs'` **and** `export const dynamic = 'force-dynamic'`, which is exactly the combination `output: 'export'` refuses to build (*"Page cannot use both 'force-dynamic' and be statically exported"*). None of them can survive the migration in place.

| Route | Methods | Purpose | Migration target |
|---|---|---|---|
| `/api/auth/check-availability`<br>`app/api/auth/check-availability/route.ts:11` | POST | Rate-limited (30/min/IP) lookup of whether a phone or email is already taken by a **verified** `customers` row. Pure DB read + `formatPhoneE164` + `isValidEmail`. | Supabase Edge Function `auth-check-availability`. Needs the service key (queries an RLS-locked table), so it cannot become a direct client call. |
| `/api/auth/init-signup`<br>`app/api/auth/init-signup/route.ts:15` | POST | The heavy one. Validates phone/email/password, checks already-registered, applies 4 rate limits, AES-256-GCM-encrypts the password into `signup_sessions`, generates two 6-digit OTPs, and fires Movider SMS + Resend email in parallel. Returns `session_id` + masked contact. | Supabase Edge Function `auth-init-signup`. Carries `lib/otp.ts`, `lib/movider.ts`, `lib/email.ts`, `lib/rateLimit.ts`, `lib/mask.ts` with it. `node:crypto` → Deno `crypto.subtle` / `node:crypto` compat. |
| `/api/auth/complete-signup`<br>`app/api/auth/complete-signup/route.ts:10` | POST | Verifies both OTPs (5-attempt cap, expiry, HMAC compare), decrypts the stored password, `auth.admin.createUser`, seeds `customers` + `creators` rows, signs in to mint tokens, deletes the signup session, returns `access_token` + `refresh_token`. | Supabase Edge Function `auth-complete-signup`. Requires service role for `auth.admin.createUser` — must stay server-side, never a direct client call. |
| `/api/auth/resend-code`<br>`app/api/auth/resend-code/route.ts:14` | POST | Re-sends one channel (`sms` \| `email`). Enforces the same rate limits plus a 60s per-channel cooldown, invalidates prior unverified codes, inserts + sends a new one. | Supabase Edge Function `auth-resend-code`. |
| `/api/auth/login`<br>`app/api/auth/login/route.ts:17` | POST | Server-side `signInWithPassword` through the cookie-bound `@supabase/ssr` client so the middleware guard sees the user next request. Maps Supabase errors to generic Thai messages (deliberately identical for wrong-password vs unknown-email). | **Delete.** Replace with a direct client-side `supabase.auth.signInWithPassword()`. The only reason this route exists is to write HTTP-only cookies for `middleware.ts` — and middleware is going away (§4). The Thai error-mapping logic (`route.ts:39-59`) moves verbatim into a client-side helper. |

**Server-only helpers that go with them** (these are all correctly fenced today and must not leak into the client bundle):

- `lib/supabase-server.ts:1` — `import 'server-only'`; `getServiceSupabase()`, `getAnonSupabase()`, `getRouteHandlerSupabase()`
- `lib/rateLimit.ts:1` — `import 'server-only'`
- `lib/movider.ts:1` — `import 'server-only'`
- `lib/email.ts:1` — `import 'server-only'`
- `lib/otp.ts` — **not fenced**; see Housekeeping §18.

#### 4. Middleware / Edge Runtime

- `middleware.ts:8` — `export async function middleware(req: NextRequest)`. Root-level middleware. It builds an `@supabase/ssr` server client from request cookies (`middleware.ts:11-26`), calls `supabase.auth.getUser()` (`middleware.ts:28-30`), and redirects unauthenticated users to `/login?redirect=<path>` (`middleware.ts:43-47`).
- `middleware.ts:52-61` — `export const config.matcher` covering `/dashboard`, `/wallet`, `/settings`, `/subscriptions`, `/following`, `/messages`, `/creator/apply`.

**This is the app's only auth guard.** Middleware does not run in a Capacitor shell — there is no server in front of the WebView. With `output: 'export'` the middleware is not emitted at all, so **every protected route becomes publicly reachable in the native app** with no redirect. This is a security regression, not just a build failure.

`export const runtime = 'edge'`: **no occurrences anywhere in the repo.** The five route handlers all pin `runtime = 'nodejs'` instead (`check-availability/route.ts:8`, `complete-signup/route.ts:5`, `init-signup/route.ts:12`, `login/route.ts:5`, `resend-code/route.ts:9`).

**Migration target:** a client-side `<RouteGuard>` in `app/dashboard/layout.tsx` (converted to `'use client'`) that reads `supabase.auth.getSession()` and calls `router.replace('/login?redirect=' + pathname)` when there's no session. Belt-and-braces: enforce the same protection at the data layer with Supabase RLS, so a bypassed client guard leaks nothing.

#### 5. Dynamic routes without `generateStaticParams`

**None.** `find app -type d -name "*[*]*"` returns nothing — there are no `[param]`, `[...slug]`, or `[[...slug]]` segments anywhere under `app/`. Repo-wide grep for `generateStaticParams` and `dynamicParams` also returns zero, consistent with there being nothing to parameterise.

✅ Nothing to do here **today** — but note this is the single most likely thing to regress. The moment a `/creator/[handle]` or `/live/[id]` route lands (both are implied by `components/dashboard/nav.ts:23-28`), it will need `generateStaticParams` + a client-side fetch, or it will break the export. Worth a lint rule or a CI check.

#### 6. `next.config.{js,mjs,ts}`

See the **Current next.config** section above. Counted as 1 P0 blocker: the file as it stands cannot produce a Capacitor bundle.

---

### P1 — Soft blockers

#### 7. `next/image`

Two files, both real usages (plus one comment that is *not* a usage):

- `components/auth/AnimatedLogo.tsx:3` — `import Image from 'next/image';`
- `components/auth/AnimatedLogo.tsx:71-79` — `<Image src="/aurum-live-logo.png" width={width} height={height} priority ... />`, wrapped in a `framer-motion` blink container. Used by the signup modal (`components/auth/SignupModal.tsx:100`) and the dashboard hero (`components/dashboard/HeroWelcome.tsx:24`).
- `components/dashboard/TopBar.tsx:3` — `import Image from 'next/image';`
- `components/dashboard/TopBar.tsx:60` — `<Image src="/aurum-live-logo.png" alt="AURUM Live" width={100} height={67} priority />`

Both point at a **local** asset in `public/`, so the simplest fix is `images: { unoptimized: true }` in `next.config.ts` — the components then need no edit at all and keep their explicit `width`/`height`. Switching them to plain `<img>` is also viable and drops a dependency from the bundle; either is fine, but `unoptimized: true` is the smaller, lower-risk diff.

**Already Capacitor-safe (do not change):**
- `components/dashboard/Avatar.tsx:25` — plain `<img>` for remote DiceBear SVGs, with an explicit `eslint-disable-next-line @next/next/no-img-element` and a comment at `Avatar.tsx:23` explaining exactly why.
- `app/page.tsx:17`, `app/page.tsx:47`, `app/page.tsx:50`, `app/login/page.tsx:57`, `app/creator/apply/page.tsx:7`, `app/explore/page.tsx:11`, `app/onboarding/page.tsx:16` — all plain `<img>` against `public/` assets.

#### 8. `next/font`

**No `next/font/google` or `next/font/local` imports anywhere.** ✅ No build-time font blocker.

⚠️ **But there is a font problem, and it is worse in the app than on the web.** The Thai typeface is requested by name only, with no `@font-face` and no stylesheet link:

- `app/globals.css:9` — `body{...font-family:"Noto Sans Thai","Leelawadee UI",Arial,sans-serif}`
- `components/auth/SignupModal.tsx:40` — `const THAI_FONT = '"Noto Sans Thai", "Leelawadee UI", Arial, sans-serif';`, applied inline at `SignupModal.tsx:84`
- `lib/email.ts:53` — same stack in the transactional-email template (irrelevant to Capacitor; noted for completeness)
- `app/layout.tsx:21-25` — the root layout renders `<html lang="th"><body>` with **no** `<link rel="stylesheet">` and no font preload

On Android WebView, *Noto Sans Thai* is a system font, so this happens to work. On **iOS WKWebView it is not installed** — every Thai glyph in the app falls back to `Arial`/system sans, which renders Thai with wrong metrics, wrong line-height, and noticeably worse legibility at small sizes. Since the entire UI copy is Thai, this affects every screen.

**Fix:** self-host Noto Sans Thai (subset to the Thai + Latin ranges) under `public/fonts/` with a real `@font-face` in `globals.css`. Do **not** use a Google Fonts `<link>` — it is a network dependency at first paint inside the shell and will flash unstyled text on a cold/offline launch.

#### 9. Absolute URLs to the app itself

Grep for `creatorlivetech.com`, `creator-livetech.vercel.app`, `localhost:3000`, `http://localhost`:

- `lib/email.ts:66` — `© 2026 AURUM TECH · creatorlivetech.com` — **display text in the email footer, not a link.** Harmless, but it should read from the same constant once one exists.
- `README.md:30` — `npm run dev # เปิด http://localhost:3000` — documentation only. No action.

**There are no hardcoded app URLs in application code.** That sounds good, but the real finding is the inverse: **there is no `APP_WEB_URL` concept at all**, and the app instead relies on *relative* paths that silently break in the shell.

**The actual problem — relative `/api/*` fetches.** Inside Capacitor the WebView origin is `capacitor://localhost` (iOS) or `http://localhost` (Android), pointing at the bundled filesystem. A relative fetch resolves against *that*, not against creatorlivetech.com, so each of these returns the static bundle's 404 instead of hitting a backend:

- `components/auth/hooks/useSignupFlow.ts:52` — `fetch('/api/auth/init-signup', ...)`
- `components/auth/hooks/useSignupFlow.ts:77` — `fetch('/api/auth/complete-signup', ...)`
- `components/auth/hooks/useSignupFlow.ts:102` — `fetch('/api/auth/resend-code', ...)`
- `app/login/page.tsx:24` — `fetch("/api/auth/login", ...)`

(`lib/movider.ts:52` also calls `fetch`, but against the absolute `MOVIDER_API_URL` at `lib/movider.ts:3`, server-side only — not affected.)

**Fix:** introduce `NEXT_PUBLIC_APP_WEB_URL` (production web origin, for checkout hand-off) and `NEXT_PUBLIC_API_BASE_URL` (Supabase Edge Function base). Route every outbound call through one `lib/config.ts` accessor rather than string-concatenating at call sites. `useSignupFlow.ts` is already a clean seam — all three signup calls go through it — so most of this lands in one file.

#### 10. Cookie-based auth / server sessions

The app currently runs a **fully cookie-based, server-validated** session model. Every piece of it is Capacitor-incompatible:

- `middleware.ts:15-25` — `cookies.getAll`/`setAll` on the request/response pair; the entire guard depends on cookie round-tripping.
- `lib/session.ts:3,20-31` — `cookies()` from `next/headers` feeding `createServerClient`, with `setAll: () => {}` and the comment at `lib/session.ts:27` noting *"Server Components cannot set cookies; middleware refreshes them"* — an explicit dependency on middleware existing.
- `lib/supabase-server.ts:65-84` — `getRouteHandlerSupabase()`, whose whole purpose (per the doc comment at `lib/supabase-server.ts:59-64`) is to let `signInWithPassword` write session cookies onto the response.
- `app/api/auth/login/route.ts:33-34` — the one caller of the above.

**Two client-side Supabase clients coexist with different storage, which is its own bug:**

- `lib/supabase-browser.ts:21` — `createClient(url, anonKey)` from `@supabase/supabase-js`. Default storage: **`localStorage`**. This is what receives the tokens after signup (`components/auth/steps/Step2Verify.tsx:64-67`, `auth.setSession({access_token, refresh_token})`).
- `components/dashboard/TopBar.tsx:34-38` — `createBrowserClient(...)` from `@supabase/ssr`. Default storage: **cookies**. This is what `logout()` calls `signOut()` on.

So today, signup writes the session to `localStorage` and logout clears the *cookie* store. On the web the middleware papers over the gap; in a Capacitor shell with no middleware, **logout will not actually end the session**.

**Migration target:** one Supabase client, created once, with an explicit storage adapter backed by `@capacitor/preferences` (Keychain on iOS, `EncryptedSharedPreferences` on Android) when running natively and `localStorage` on the web. Pass it as `auth.storage` to `createClient`. Delete `@supabase/ssr` from the client path entirely. `Step2Verify.tsx:64` and `TopBar.tsx:34` then talk to the same store.

**Also note:** `getBrowserSupabase()` in `lib/supabase-browser.ts:11` is a lazy singleton — good — but it is marked `'use client'` at line 1 while `lib/supabase-server.ts` is `server-only`. Keeping that split is right; just consolidate *which* browser client everyone uses.

#### 11. Direct DB access via API routes instead of the Supabase client

All five routes are Postgres hops, but they are not all the same case:

- `app/api/auth/check-availability/route.ts:42-48` and `:57-63` — two `customers` `select` queries, results returned straight to the browser as `{phone_available, email_available}`. This is the textbook wasteful hop. **However** it uses `getServiceSupabase()` (`route.ts:34`) because `customers` is RLS-locked, so it cannot simply become a client-side query without either loosening RLS or adding a `SECURITY DEFINER` RPC. Recommended: a Postgres RPC `check_signup_availability(phone, email)` marked `SECURITY DEFINER` and callable by `anon`, invoked directly from the client. That removes the hop *and* keeps the table locked.
- `app/api/auth/resend-code/route.ts:31-35, 64-70, 84-89, 94-96, 105-107` — reads and writes `signup_sessions`, `phone_otps`, `email_codes`. Must stay server-side (holds the OTP secret).
- `app/api/auth/init-signup/route.ts:50-63, 91-101, 111-122` — same, plus password encryption.
- `app/api/auth/complete-signup/route.ts:28-32, 42-59, 68-71, 102-109, 139-150, 157-161, 183` — same, plus `auth.admin.createUser` (`route.ts:120`) which requires service role by definition.
- `lib/rateLimit.ts:26-44` — the `auth_rate_limits` ledger, service-role only.

**Verdict:** one route (`check-availability`) should collapse into a client-side RPC. The other four must become Edge Functions — they hold secrets that can never reach a mobile bundle.

---

### P2 — Mobile UX

#### 12. Viewport / responsive

The codebase has **two different, inconsistent responsive strategies**:

**Desktop-first (the landing/portal pages, hand-written CSS in `app/globals.css`).** Everything is authored for wide screens and walked back with `max-width` queries:

- `app/globals.css:11` — `@media(max-width:1150px){...}` (14 overrides)
- `app/globals.css:12` — `@media(max-width:760px){...}` (~40 overrides)
- `app/globals.css:19` — `@media(max-width:900px){...}` and `@media(max-width:600px){...}`
- `app/globals.css:22` — `@media(max-width:480px){...}`

There are **no `min-width` queries anywhere** and no `min-width: 1024px` gates — so nothing is hard-locked to desktop; it degrades rather than breaks. But every new rule has to be written twice.

**Hardcoded pixel dimensions that don't adapt** (all in `app/globals.css:9`, `:11`, `:12`, `:18`, `:21` — the file is minified so several rules share a line; selectors given for precision):

- `.hero{min-height:860px}` → overridden to `1450px` at ≤1150px and `1180px` at ≤760px. On a 667px-tall iPhone SE viewport that is ~1.8 screens of forced scroll before any content.
- `.dashboard-shell{height:630px}` → `620px` → `515px`. Fixed height, not content-driven.
- `.live-card{height:386px}` → `320px`; `.chat-panel{height:355px}`; `.creator-cover{height:210px}`; `.big-chart{height:150px}`; `.search-box{height:66px}`; `.site-header{height:82px}`; `.portal-nav{height:78px}`.
- `.brand img{width:178px;height:66px}` (`globals.css:14`), `.portal-nav img{width:170px;height:62px}`, `.auth-logo{width:190px;height:70px}`, `.portal-sidebar img{width:180px;height:65px}` — fixed logo boxes.
- `.hero-stats{left:76px;width:62%;height:120px}` — absolutely positioned with a px offset.
- `.dashboard-page{grid-template-columns:240px 1fr}` and `.portal-sidebar{height:100vh}` (`globals.css:18`).

**Mobile-first (the dashboard, Tailwind).** This half is done correctly — bare classes are the mobile case and `md:`/`lg:` progressively enhance:

- `components/dashboard/DashboardShell.tsx:33` — `hidden ... md:block` sidebar
- `components/dashboard/DashboardShell.tsx:38` — `px-4 pb-24 pt-6 md:px-8 md:pb-8`
- `components/dashboard/MobileBottomNav.tsx:10` — `md:hidden`
- `components/dashboard/RecommendedCreators.tsx:8` — `grid-cols-2 ... lg:grid-cols-4`
- `components/auth/SignupModal.tsx:91` — `grid-cols-1 ... md:grid-cols-2`
- `components/dashboard/HeroWelcome.tsx:14` — `flex-col ... md:flex-row`

**Recommendation:** the app shell should ship `/dashboard/*` only. Leave the desktop-first landing CSS on the web and don't route to it from the native shell — converting `globals.css` to mobile-first is a large, purely cosmetic diff with no Capacitor payoff.

#### 13. Touch targets under 44×44px

Apple HIG and Material both want ≥44pt / 48dp. Measured from the classes as written:

- `components/dashboard/TopBar.tsx:53` — hamburger, `h-9 w-9` = **36×36px**. This is the primary mobile navigation control.
- `components/dashboard/TopBar.tsx:83` — notification bell, `h-9 w-9` = **36×36px** (hidden below `sm:`, so lower impact).
- `components/dashboard/DashboardShell.tsx:58` — drawer close button, `h-9 w-9` = **36×36px**.
- `components/dashboard/Sidebar.tsx:25` — nav links, `px-3 py-2.5` with `text-sm` ⇒ 10px + 20px line-box + 10px = **~40px tall**. Used in the mobile drawer.
- `components/dashboard/CreatorCard.tsx:22` — follow button, `py-2 text-sm` ⇒ 8 + 20 + 8 = **~36px tall** (full-width, so only the vertical axis fails).
- `components/dashboard/PopularCategories.tsx:29` — category chips, `px-4 py-2 text-sm` ⇒ **~36px tall**.
- `app/globals.css:12` — `.button.small{min-height:40px}` inside the ≤760px query. This is the "สมัครเป็น Creator" header CTA on the landing page — **40px at exactly the breakpoint where it matters most.**
- `app/globals.css:9` — `.dash-sidebar a{padding:9px 4px}` with `font-size:16px` ⇒ ~34px; `.stream-controls span{width:32px;height:32px}`.
- `app/globals.css:18` — `.filter-row button{padding:12px 22px}` ⇒ ~41px; `.verified{padding:7px 10px;font-size:10px}` ⇒ ~26px (decorative badge, not interactive — no action needed).
- `components/auth/SignupModal.tsx:119-125` — modal close `✕` is a bare `<button>` with only `absolute right-5 top-5` and no sizing — the hit area is the glyph itself, roughly **16×16px**. Worst offender in the codebase.

**Comfortably passing** (listed so the fix PR doesn't churn them): `components/auth/fields/OtpInput.tsx:56` `w-12 h-14` = 48×56px ✅; `Step1Credentials.tsx:146` and `Step2Verify.tsx:158` submit buttons `h-12` = 48px ✅; `globals.css:9` `.button{min-height:58px}` ✅; `.application-card input{height:48px}` ✅; `.auth-form input{height:50px}` ✅.

#### 14. Fixed-position elements without iOS safe-area handling

**No `env(safe-area-inset-*)` and no `viewport-fit=cover` appear anywhere in the repo.** `app/layout.tsx` exports `metadata` (`app/layout.tsx:4-14`) but **no `viewport` export**, so Next emits its default `width=device-width, initial-scale=1` — without `viewport-fit=cover`, `env(safe-area-inset-*)` resolves to `0px` even after it's added. That has to be fixed first or every other safe-area change is a no-op.

- `components/dashboard/MobileBottomNav.tsx:10` — `fixed inset-x-0 bottom-0 z-30 ... h-16 ... md:hidden`. **The single worst case.** On any iPhone with a home indicator, the bottom ~34px of this 64px bar sits under the gesture area — the nav labels are clipped and the bottom row of tap targets competes with the system swipe-up.
- `components/dashboard/DashboardShell.tsx:38` — `pb-24` (96px) on `<main>` is a hardcoded offset for that 64px bar. It happens to leave 32px of slack, which accidentally *almost* covers the home indicator — but it's a magic number, not a safe-area calculation, and it's wrong on Android (no inset needed) and on iPad.
- `components/dashboard/TopBar.tsx:47` — `sticky top-0 z-30 h-16`. Under the notch/Dynamic Island the top ~47px is occluded; the logo and hamburger sit behind the status bar.
- `components/dashboard/DashboardShell.tsx:45` — mobile drawer, `fixed inset-0 z-40 md:hidden`; the inner panel at `DashboardShell.tsx:51` is `h-full w-72`, so its top row (`DashboardShell.tsx:52`, `h-16`) lands under the notch too.
- `components/auth/SignupModal.tsx:74` — `fixed inset-0 z-50 ... p-4`. Only 16px of padding; the modal card (`SignupModal.tsx:91`, `max-h-[92vh]`) can extend into both the notch and the home indicator. The close button (`SignupModal.tsx:121`, `absolute right-5 top-5`) is a particular risk — top-right is exactly where the Dynamic Island sits.
- `app/globals.css:18` — `.portal-nav{position:sticky;top:0;height:78px}` and `.portal-sidebar{height:100vh;position:sticky;top:0}`.

**`100vh` usage** (in a mobile WebView, `100vh` ignores the collapsing browser chrome and overflows):
- `app/globals.css:9` — `main{min-height:100vh}`
- `app/globals.css:18` — `.portal-page{min-height:100vh}`, `.portal-sidebar{height:100vh}`
- `app/globals.css:21` — `.auth-page{min-height:100vh}`
- `components/ComingSoon.tsx:5` — `min-h-screen`
- `components/dashboard/DashboardShell.tsx:23` — `min-h-screen`
- `components/dashboard/DashboardShell.tsx:33` — `h-[calc(100vh-4rem)]`

All of these want `100dvh` (or `min-h-dvh`) for correct behaviour in the shell.

#### 15. External links

- **`window.open`: zero occurrences.** ✅
- **External `<a href="https://...">`: zero occurrences.** ✅

The only outbound links are two `mailto:` anchors and one remote image host:

- `app/page.tsx:79` — `<a className="button" href="mailto:hello@aurumlive.example">` (main CTA in the `#start` section)
- `app/page.tsx:81` — `<a href="mailto:hello@aurumlive.example">ติดต่อเรา</a>` (footer)
- `lib/mockData.ts:37` — `https://api.dicebear.com/9.x/avataaars/svg?seed=...`, rendered via `components/dashboard/Avatar.tsx:25`

In a Capacitor WebView a bare `mailto:` either does nothing or navigates the WebView to a dead URL. These need `@capacitor/app`'s `AppLauncher.openUrl()` (for `mailto:`) or `@capacitor/browser`'s `Browser.open()` (for `https:`).

**The important forward-looking point:** because there are currently *zero* `https://` anchors and *zero* `window.open` calls, there is nothing to retrofit — which means the right move is to build the abstraction **now**, before the checkout flow lands. A single `lib/native/openExternal.ts` that dispatches to `Browser.open()` natively and `window.open()` on web, adopted from day one, is a ~30-line file. Retrofitting it after the Fanvue feature PRs land will be far more expensive.

`Browser.open()` is also a hard requirement (not a nicety) for the "Web Checkout, App View" pattern: the in-app browser shares the auth cookie jar with the app's WebView on iOS, so the user arrives at `creatorlivetech.com/checkout` already signed in and the post-purchase state syncs back. `AppLauncher`/system-browser does not give you that.

#### 16. Remote image dependency

`lib/mockData.ts:37` builds every mock avatar from `api.dicebear.com`. In the shell this means the dashboard shows empty avatar circles on a cold or offline launch. `components/dashboard/Avatar.tsx:14, 22-28` already falls back to a gradient initial when `src` is null — but not when `src` is set and the *request* fails. Worth an `onError` fallback, and worth bundling a few local placeholder avatars before the mock data is replaced with real Supabase Storage URLs.

---

### Payment abstraction

**No payment code exists.** Repo-wide, case-insensitive grep across `.ts`, `.tsx`, `.sql`, and `.md` for `stripe`, `promptpay`, `oxapay`, `checkout`, `payment`, and `billing` returns **zero matches**. There is no `lib/payment/`, no checkout route, no webhook handler, and no payment tables in `supabase/migrations/20260806_signup_auth_tables.sql` (which defines only `customers`, `creators`, `signup_sessions`, `phone_otps`, `email_codes`, `auth_rate_limits`).

The closest things to money in the codebase are all hardcoded display strings:

- `app/explore/page.tsx:2-4` — `price: "฿299/เดือน"` etc. in a literal array
- `components/dashboard/TopBar.tsx:90` — a hardcoded `฿0` wallet balance chip
- `app/page.tsx:55-56, 76` — `฿24,780`, `฿18,540 / ฿30,000`, `฿128,450` in landing-page mockups
- `app/wallet/page.tsx:4` — renders `<ComingSoon title="กระเป๋าเงิน" />`
- `app/subscriptions/page.tsx:4` — renders `<ComingSoon title="สมาชิกของฉัน" />`

**This is good news and should be treated as the main opportunity in this audit.** There is no legacy payment code to untangle, so the service layer can be designed correctly from the first line. Recommended shape, established *before* any Fanvue feature PR:

```
lib/payment/
  types.ts          # Product, Price, CheckoutIntent, PurchaseResult
  index.ts          # startCheckout(intent) — the ONLY thing UI imports
  providers/
    webCheckout.ts  # native: Browser.open(`${APP_WEB_URL}/checkout?...`)
    stripe.ts       # web: direct Stripe redirect
```

**Non-negotiable rule to enforce from PR 1:** no UI component ever imports a provider or constructs a checkout URL. Components call `startCheckout()`; the service layer decides web-redirect vs `Browser.open()` based on `Capacitor.isNativePlatform()`. This is also what keeps App Store / Play review manageable — the platform-conditional logic lives in exactly one file.

---

### Housekeeping

#### 17. Environment variables

Every `process.env.*` reference in the repo:

| Variable | Referenced at | Prefix correct? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `middleware.ts:12`, `lib/session.ts:22`, `lib/supabase-browser.ts:14`, `lib/supabase-server.ts:22,44,66`, `components/dashboard/TopBar.tsx:35` | ✅ Correct. The project URL is public by design; server code reading the same var is fine and avoids a duplicate. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `middleware.ts:13`, `lib/session.ts:23`, `lib/supabase-browser.ts:15`, `lib/supabase-server.ts:45,67`, `components/dashboard/TopBar.tsx:36` | ✅ Correct. The anon key is meant to be public and is RLS-gated. |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/supabase-server.ts:23` | ✅ Correctly **un**-prefixed. Only reachable from a `server-only` module. **Must never gain a `NEXT_PUBLIC_` prefix** — in a static export that would bake a full RLS-bypass key into a downloadable app bundle. |
| `OTP_HMAC_SECRET` | `lib/otp.ts:13` | ✅ Correctly un-prefixed. |
| `SESSION_ENCRYPTION_KEY` | `lib/otp.ts:49` | ✅ Correctly un-prefixed. |
| `MOVIDER_API_KEY` | `lib/movider.ts:27` | ✅ Correctly un-prefixed. |
| `MOVIDER_API_SECRET` | `lib/movider.ts:28` | ✅ Correctly un-prefixed. |
| `MOVIDER_SENDER_NAME` | `lib/movider.ts:29` | ✅ Correctly un-prefixed. |
| `RESEND_API_KEY` | `lib/email.ts:16` | ✅ Correctly un-prefixed. |
| `RESEND_FROM_EMAIL` | `lib/email.ts:17` | ✅ Correctly un-prefixed. |

**No misuse found in either direction.** Nothing leaks to the client that shouldn't, and nothing needed in the browser lacks the prefix. `.env.example:9-26` documents all ten.

**Missing, and needed for Capacitor:**
- `NEXT_PUBLIC_APP_WEB_URL` — the production web origin (`https://creatorlivetech.com`) that the native shell opens for checkout. Needs the public prefix.
- `NEXT_PUBLIC_API_BASE_URL` — the Supabase Edge Function base, so the four relative `/api/*` fetches (§9) become absolute.
- `NEXT_PUBLIC_CAPACITOR_BUILD` (or equivalent) — lets `next.config.ts` toggle `output: 'export'` without forking the config for web vs app.

⚠️ **Static-export caveat:** `NEXT_PUBLIC_*` values are inlined at **build** time, not read at runtime. In a Vercel deployment they can be changed by redeploying; in a shipped `.ipa`/`.apk` they are frozen until the next store release. Pick these values carefully — a wrong `NEXT_PUBLIC_API_BASE_URL` is a store-review round trip, not a redeploy.

#### 18. Bundle-side dependencies

`package.json:14-26` runtime dependencies, checked for Node-only code reaching the client:

| Package | Client-safe? | Notes |
|---|---|---|
| `@supabase/supabase-js` | ✅ | Isomorphic. |
| `@supabase/ssr` | ⚠️ | Imported by `middleware.ts:2`, `lib/session.ts:4`, `lib/supabase-server.ts:3` (all server) **and by `components/dashboard/TopBar.tsx:6`** (`createBrowserClient`). See P1 §10 — this last one should be removed and the package dropped from the client path entirely once middleware is gone. |
| `canvas-confetti` | ✅ | `components/auth/steps/Step3Success.tsx:5`, browser-only, inside `useEffect`. |
| `framer-motion` | ✅ | `AnimatedLogo.tsx:4`, `SignupModal.tsx:3`, `StarField.tsx:3`, `Step3Success.tsx:3`. |
| `libphonenumber-js` | ✅ | `lib/phone.ts:6`. Pure JS, deliberately client-safe — see the comment at `lib/phone.ts:2-5`. Adds ~145KB to the bundle; worth a `min` build or lazy import in a later perf pass, not a Capacitor blocker. |
| `lucide-react` | ✅ | `components/dashboard/nav.ts:1`, `PopularCategories.tsx:1`, `TopBar.tsx:7`, `DashboardShell.tsx:3`. |
| `react-international-phone` | ✅ | `components/auth/fields/PhoneInput.tsx`. |
| `resend` | ✅ | `lib/email.ts:2`, fenced by `import 'server-only'` at `lib/email.ts:1`. Node-only, but correctly walled off. |
| `next`, `react`, `react-dom` | ✅ | — |

**No `fs`, `child_process`, `pg`, `bcrypt`, or similar Node-only packages are imported into client code.** ✅

⚠️ **One real gap — `lib/otp.ts` has no `server-only` guard.** `lib/otp.ts:1` is `import crypto from 'node:crypto';` and the file uses `Buffer` at lines 20, 21, 29, 32, 39, 42, 43, 44 — but unlike `lib/email.ts:1`, `lib/movider.ts:1`, `lib/rateLimit.ts:1`, and `lib/supabase-server.ts:1`, it does **not** open with `import 'server-only'`. Today it is only imported by route handlers (`init-signup/route.ts:6`, `complete-signup/route.ts:3`, `resend-code/route.ts:5`), so nothing is broken. But there is no compile-time guard stopping someone from importing `hashOtp` into a client component — which in a static export would either fail the build with an opaque polyfill error or, worse, bundle a code path that reads `OTP_HMAC_SECRET`. Add `import 'server-only';` as line 1. One-line fix, worth doing in PR 1.

**Minor, non-blocking:** two placeholder handlers ship `console.log` as their entire implementation — `components/dashboard/TopBar.tsx:71` (search on Enter) and `components/dashboard/LiveCard.tsx:15` (open a live session). Both are dead-end interactions that will read as broken buttons in a native app where users expect every tap to do something. Not a Capacitor blocker; flagging because they are user-visible.

---

## Refactor plan (proposed PR sequence)

Sequenced so the build is never broken for more than one PR at a time, and so nothing in the Fanvue feature work is blocked behind the long Edge Function migration. **PRs 1–4 can land in parallel with feature work. PR 5 is the long pole and should start immediately.**

### PR 1 — Static-export build config + Capacitor scaffold
- **Scope:** Add `output: 'export'` (gated on `process.env.NEXT_PUBLIC_CAPACITOR_BUILD`), `images.unoptimized: true`, `trailingSlash: true` to `next.config.ts`. Add `capacitor.config.ts` with `webDir: 'out'`. Add `build:mobile` script. Add `import 'server-only';` to `lib/otp.ts:1`. Add the three new env keys to `.env.example`.
- **Files touched:** `next.config.ts`, `capacitor.config.ts` (new), `package.json`, `lib/otp.ts`, `.env.example`, `.gitignore` (`ios/`, `android/`)
- **Estimated size:** S (~60 LoC)
- **Risk:** Low. The export build will still fail — that's expected and desired, it becomes the checklist for PRs 2–6. Add a CI job that runs `npm run build:mobile` and is *allowed to fail* until PR 6, then flip it to required.

### PR 2 — `lib/config.ts` + env-driven URLs
- **Scope:** Create `lib/config.ts` exporting `APP_WEB_URL`, `API_BASE_URL`, `isNative()`. Rewrite the four relative fetches to absolute. No behaviour change on web (base URL defaults to `''`).
- **Files touched:** `lib/config.ts` (new), `components/auth/hooks/useSignupFlow.ts:52,77,102`, `app/login/page.tsx:24`
- **Estimated size:** S (~80 LoC)
- **Risk:** Low. Fully backward-compatible — an empty base URL reproduces today's behaviour exactly.

### PR 3 — Unify the Supabase client + Capacitor storage adapter
- **Scope:** Make `lib/supabase-browser.ts` the single client, with an `auth.storage` adapter that uses `@capacitor/preferences` natively and `localStorage` on web. Repoint `TopBar.logout()` off `createBrowserClient`. **This also fixes the real logout bug in §10** (signup writes `localStorage`, logout clears cookies) independent of Capacitor.
- **Files touched:** `lib/supabase-browser.ts`, `lib/storage/capacitorAdapter.ts` (new), `components/dashboard/TopBar.tsx:6,34-38`
- **Estimated size:** S/M (~120 LoC)
- **Risk:** Medium — touches live auth. Ship behind a manual QA pass: signup → session persists → reload → still signed in → logout → actually signed out, on web *and* in a dev shell. Worth landing early: it's a genuine web bug fix, not just Capacitor prep.

### PR 4 — Client-side route guard, replacing middleware
> **Superseded by PR 6.** `<RouteGuard>` shipped and has since been deleted: the check now lives
> per route in `lib/hooks/useRequireAuth.tsx`, so there is no wrapper component any more.

- **Scope:** Convert `app/dashboard/layout.tsx` to `'use client'`. Add `<RouteGuard>` reading `supabase.auth.getSession()`, redirecting to `/login?redirect=<path>` — same contract as `middleware.ts:43-47`, so `app/login/page.tsx:10` needs no change. Delete `lib/session.ts`; replace `getDashboardUser()` with a `useDashboardUser()` client hook. **Do not delete `middleware.ts` yet** — keep it for the web build as defence in depth.
- **Files touched:** `app/dashboard/layout.tsx`, `app/dashboard/page.tsx`, `lib/session.ts` (deleted), `lib/hooks/useDashboardUser.ts` (new)
- **Estimated size:** M (~180 LoC)
- **Risk:** Medium. Adds a brief unauthenticated flash before the guard resolves — mitigate with a skeleton, not a blank screen. **Pair with an RLS audit**: once the guard is client-side, RLS is the only real boundary. Verify `customers`, `creators`, and every future content table deny `anon` reads before this merges.

### PR 5 — Auth backend → Supabase Edge Functions *(split into three)*

The long pole. Split so each piece is independently reviewable and the client can migrate one endpoint at a time.

**PR 5a — Shared Edge Function utilities**
- **Scope:** Port `lib/otp.ts`, `lib/rateLimit.ts`, `lib/mask.ts`, `lib/validation.ts`, `lib/phone.ts` to `supabase/functions/_shared/`. `node:crypto` → Deno equivalents. `lib/validation.ts` and `lib/phone.ts` are already framework-free (see the comments at `lib/validation.ts:1-5` and `lib/phone.ts:2-5`) so they port nearly verbatim.
- **Estimated size:** M (~250 LoC) · **Risk:** Medium — the AES-256-GCM and HMAC paths must produce byte-identical output to `lib/otp.ts`, or in-flight signup sessions break at cutover. Requires round-trip tests against the Node implementation before deploy.

**PR 5b — `init-signup` + `resend-code` Edge Functions**
- **Scope:** Port both, including `lib/movider.ts` and `lib/email.ts`. Repoint `useSignupFlow.ts:52,102`.
- **Estimated size:** M (~280 LoC) · **Risk:** Medium — external providers (Movider, Resend) need their credentials moved to Edge Function secrets and re-verified against a live send.

**PR 5c — `complete-signup` + `check-availability`, delete `/api/auth/login`**
- **Scope:** Port `complete-signup` (keeps service role for `auth.admin.createUser`). Replace `check-availability` with a `SECURITY DEFINER` RPC callable by `anon`. Replace the login route with a direct client-side `signInWithPassword`, carrying the Thai error mapping from `app/api/auth/login/route.ts:39-59` verbatim into a client helper. Delete `app/api/` and `lib/supabase-server.ts`.
- **Estimated size:** M/L (~300 LoC + a migration) · **Risk:** **High.** This is account provisioning. Do not merge without an end-to-end signup test on a staging Supabase project, and keep the old routes deployed on web for one release as a rollback path.

### PR 6 — Delete middleware, green the export build
> **Shipped, wider than scoped here.** Both layers went: `middleware.ts` *and* `<RouteGuard>`.
> All seven matcher paths now run `useRequireAuth()` in the page (or, for `/dashboard/*`, in
> `DashboardChrome`). Server-Component cookie auth was rejected — see the rationale in
> `lib/hooks/useRequireAuth.tsx`.

- **Scope:** Delete `middleware.ts`. Confirm `npm run build:mobile` succeeds. Flip the PR 1 CI job to required.
- **Files touched:** `middleware.ts` (deleted), `components/dashboard/RouteGuard.tsx` (deleted), the seven protected routes, CI config
- **Estimated size:** S (~20 LoC) · **Risk:** Low *if* PR 4's guard and the RLS audit both landed. **This PR is the point of no return for server-side auth** — verify RLS one more time before merging.

### PR 7 — Mobile UX: safe areas, touch targets, viewport
- **Scope:** Add a `viewport` export with `viewportFit: 'cover'` to `app/layout.tsx` **first** (nothing else works without it). Then `env(safe-area-inset-*)` on `MobileBottomNav`, `TopBar`, the drawer, and `SignupModal`. Replace `pb-24` with a computed offset. `100vh` → `100dvh` in six places. Raise the ten sub-44px targets from §13 — the `SignupModal` close button (~16px) first.
- **Files touched:** `app/layout.tsx`, `components/dashboard/{MobileBottomNav,TopBar,DashboardShell,Sidebar,CreatorCard,PopularCategories}.tsx`, `components/auth/SignupModal.tsx`, `components/ComingSoon.tsx`, `app/globals.css`
- **Estimated size:** M (~200 LoC) · **Risk:** Low — visual only, but needs device testing on a notched iPhone and a gesture-nav Android. **Land this before the Fanvue feature PRs** so new components inherit the pattern rather than repeating the bug.

### PR 8 — External-link + payment service layer
- **Scope:** `lib/native/openExternal.ts` dispatching to `@capacitor/browser` natively and `window.open` on web; adopt it at `app/page.tsx:79,81`. Scaffold `lib/payment/` per the shape in the Payment section — types, a `startCheckout()` facade, and a `webCheckout` provider that calls `Browser.open()` against the `APP_WEB_URL` checkout path. No provider implementation, no UI.
- **Files touched:** `lib/native/openExternal.ts` (new), `lib/payment/{types,index}.ts` + `providers/webCheckout.ts` (new), `app/page.tsx`
- **Estimated size:** S (~150 LoC) · **Risk:** Low — nothing calls it yet. **The value is entirely in landing it before the first payment feature**, so the correct seam already exists when that PR is written.

### PR 9 — Self-hosted Thai webfont
- **Scope:** Subset Noto Sans Thai (Thai + Latin), add to `public/fonts/`, `@font-face` + `font-display: swap` in `globals.css`, preload in `app/layout.tsx`. Fixes Thai rendering on iOS (§8).
- **Files touched:** `public/fonts/*` (new), `app/globals.css:9`, `app/layout.tsx`, `components/auth/SignupModal.tsx:40`
- **Estimated size:** S (~40 LoC + binaries) · **Risk:** Low. Check the subset size — an unsubset Thai font is ~400KB and lands in the app bundle.

**Suggested ordering:** 1 → 2 → 3 → 4 → (5a → 5b → 5c) → 6, with 7, 8, and 9 running in parallel at any point after PR 1. PR 3 and PR 7 both deliver standalone value to the current web app and are the safest things to start with.

---

## Open questions for Por

1. **Does the native app ship the landing page at all?** If `/`, `/explore`, and `/creator/apply` are web-only and the app opens straight to `/login` or `/dashboard`, the entire desktop-first CSS problem in §12 (`app/globals.css:11,12,18,19,22`) becomes out of scope and PR 7 shrinks by roughly half. **This is the single highest-leverage decision in the audit** — please answer before PR 7 is scoped.

2. **Supabase Edge Functions vs. keeping a small Node backend.** The audit assumes Edge Functions per the brief. But `lib/otp.ts` uses `node:crypto` AES-256-GCM + HMAC, and `lib/movider.ts:52` posts form-encoded data — all portable to Deno, but PR 5a carries real crypto-compatibility risk. An alternative is keeping the five routes on Vercel as a plain API that both web and app call over HTTPS: near-zero migration risk, at the cost of a second runtime to operate. Which trade do you want?

3. **What happens to in-flight signup sessions at cutover?** `signup_sessions` rows hold AES-256-GCM ciphertext from `lib/otp.ts:28-36` and live 15 minutes (`supabase/migrations/20260806_signup_auth_tables.sql:52`). If the Edge Function's crypto isn't byte-identical, anyone mid-signup at deploy time fails at `complete-signup`. Acceptable to deploy during a low-traffic window and accept a handful of failures, or do you want a dual-read compatibility path?

4. **Is `/creator/apply` genuinely protected?** `middleware.ts:39` guards it, but `app/creator/apply/page.tsx` is a static form with no auth-dependent content and a note at line 25 saying it doesn't submit anywhere. If it doesn't need to be protected, PR 4's guard gets simpler. Related: `app/creator/apply/page.tsx:9` links "เข้าสู่ระบบ" to `/dashboard` rather than `/login`, which looks like a bug independent of this migration.

5. **Which routes will get dynamic segments, and when?** §5 is clean *today*, but `components/dashboard/nav.ts:23-28` implies `/creator/[handle]` and `/live/[id]` are coming. Under `output: 'export'` each needs `generateStaticParams` (impossible for user-generated handles) or a catch-all shell that reads the ID client-side. **The second pattern needs to be established before the first such route is written** — retrofitting is expensive. Do you want a decision on this in PR 1?

6. **iOS in-app purchase exposure.** The Web Checkout, App View pattern is what Netflix and Fanvue do, but Apple's rules differ by content type — Fanvue-style creator subscriptions are a different Guideline 3.1 case than Netflix's "reader app" exemption. Has this been reviewed for the specific product? It doesn't change any code in this audit, but it could change whether PR 8's service layer needs a StoreKit provider alongside `webCheckout` — which would be a much larger design.

7. **Rate limiting after the middleware goes away.** `lib/rateLimit.ts` keys on `getClientIp()` (`lib/http.ts:4-11`), which reads `x-forwarded-for` — a header Vercel sets. Edge Functions see a different header set, and a mobile client can't be trusted to supply its own IP. Should rate limiting move to per-device (a Capacitor-generated install ID) or per-phone/email only? Worth deciding in PR 5a, since it changes the shared utilities' signature.

8. **Do the two placeholder handlers ship in v1?** `components/dashboard/TopBar.tsx:71` (search) and `components/dashboard/LiveCard.tsx:15` (open live) are `console.log` only. Fine on a web preview; in a native app they read as broken. Hide them behind a flag for the first app release, or is v1 late enough that they'll be real by then?
