# Live gifts — how it fits together, and where it differs from the brief

TikTok-style gifting during a live broadcast. A viewer spends stars from the
wallet they already have on one of seven น้อง Aurum tiers; the creator is
credited on the ledger tips and PPV already use; an animated overlay plays on
every screen watching the session.

## The one-paragraph version

`live-send-gift` (Edge Function) → `send_live_gift` (one plpgsql transaction:
lock the session, refuse a self-gift, price the tier, check the per-minute
ceilings, spend through the existing `deduct_stars_fifo`, insert `live_gifts`,
bump the session counters) → an `AFTER INSERT` trigger broadcasts a `gift` event
on the session's existing private `live:<session_id>` Realtime channel →
`useLiveChannel` decodes it → `useGiftQueue` schedules it → `GiftOverlay` plays
it, identically on the creator's studio, every viewer's page, and the OBS
browser source.

## FREE PREVIEW is on — every gift costs 0 stars

`gift_tiers.price_stars` is `0` for all seven tiers. A gift priced at 0 skips
the spend, the creator credit, the ledger row and the AML stars-per-minute
ceiling; the 30-sends-per-minute ceiling and the self-gift refusal still apply.

**Turning a tier back on is one statement, with no deploy:**

```sql
update public.gift_tiers set price_stars = 100 where slug = 'nova';
```

There is no flag to unset. The price IS the switch, so the drawer's `ฟรี ·
ทดสอบ` badges, its `โหมดทดสอบ` banner, the missing `+N ⭐` fragments and the
creator's `โหมดทดสอบ` chip all follow the data and stop by themselves.

One consequence worth knowing: with every price at 0 the fullscreen queue's
"most valuable first" rule ties on every comparison, so the broadcast payload
carries `gift_tiers.sort_order` and the queue breaks the tie on it. See
deviation 13.

## Operator steps before Phase E works

**One vault secret is required.** `supabase_jwt_secret` must hold the project's
JWT secret (Dashboard → Settings → API → JWT Secret). Until it is set,
`live-overlay-token` answers `503 overlay_not_configured` and the OBS overlay
says so on the canvas in Thai. Nothing else in this feature depends on it —
Phases A–D work without it.

**Pricing is 0 across the board** — see the free-preview section above. Set the
real prices with an `UPDATE` when launch approaches; no deploy is needed, and
nothing client-side hardcodes a price.

**Tiers 05–07 have no name.** They are seeded `TBD` and all three render the
generic float animation. Naming one is an `UPDATE`; giving one its own animation
is a component plus one line in `components/live/gifts/animations/index.tsx`.

---

## Deviations from the brief

Every difference between the specification and what shipped, and why.

### 1. The reference animations and mascot art do not exist

The brief listed four reference HTML files under `docs/gift-cards/` and a set of
mascot PNGs under `public/gifts/`, to be committed before the work started.
Neither exists in this repository, on any branch or anywhere in its history.

So: the four named tier animations were **authored from the written
descriptions** rather than ported from reference `.stage` blocks, and the mascot
layers under `public/gifts/` are **generated placeholders** at the exact paths,
sizes and layer split the components import. `public/gifts/README.md` documents
the contract the real art must meet — replacing it is a file copy with no code
change.

The master-timeline approach the brief asked for is preserved: every tier is a
300×300 stage whose layers are all keyed off one `--cycle` (from
`gift_tiers.duration_ms`) and the same percentage marks, running once with
`forwards`.

### 2. No `increment_tip_stars_received` RPC, and no separate earnings ledger

The brief referred to both. Neither exists, and neither is needed.

A creator's stars are recorded in exactly one place: the `star_transactions`
row that `deduct_stars_fifo` writes for the SPEND, with `creator_id` set. That
row *is* the credit — it is the same row a tip or a PPV unlock writes, read the
same way by payouts. `send_live_gift` therefore calls `deduct_stars_fifo` with
`p_transaction_type = 'live_gift'`, `p_reference_id = <gift id>` and
`p_creator_id`, and updates `live_sessions.tip_stars_received` directly.

### 3. No `wallet_spend_fifo` was created

The brief allowed for the possibility that FIFO spending lived only in
TypeScript and would have to be moved into SQL. It does not: `deduct_stars_fifo`
(migration `phase1_wallet_rpcs`) is already the atomic, row-locking
implementation, and `supabase/functions/_shared/stars.ts` is a typed wrapper
over it. `send_live_gift` calls the same function, so there is still exactly one
implementation.

### 4. The error envelope is `{ error: { code, message, detail } }`

The brief said "same envelope as the rest of the repo `{ error: { code, message } }`".
The repo has **two** envelopes: the wallet functions answer flat
`{ error, message, detail }` (`_shared/errors.ts`), and the `live-*`/`content-*`
family answers nested `{ error: { message, code } }` (`_shared/utils.ts`).
`live-send-gift` is a `live-*` function and uses the nested one, extended with a
`detail` object carrying the numbers a refusal needs (`balance`/`required` for
`INSUFFICIENT_STARS`, `max_quantity` for `QUANTITY_TOO_HIGH`).

### 5. `can_watch_live_session` takes two arguments

`can_watch_live_session(p_session_id, p_user_id)`, not one. The RLS policy on
`live_gifts` passes `(SELECT auth.uid())` explicitly.

### 6. The rate limit uses `live_gifts` itself, not a new table

The brief offered "table `live_gift_rate` or reuse a generic rate-limit helper".
`live_gifts` already carries sender, stars and timestamp, and already has the
`(sender_id, created_at DESC)` index the window scan wants — so a counter table
would have been a second thing to keep in step with the first. Both ceilings (30
sends/minute, 20,000 stars/minute) are enforced inside `send_live_gift` against
that table. Only successful sends count, which is the right measure for an AML
ceiling: what actually moved.

### 7. The broadcast payload has no `avatar_url` from `creators`, and the sender
name is derived differently

`public.creators` has no `avatar_url` column. The trigger instead resolves the
sender's identity with the **same precedence the rest of the app uses**
(`deriveDisplayName` in `lib/hooks/useDashboardUser.ts`): an explicit
`raw_user_meta_data` name, then the email local-part, then `ผู้ชม` — with
`avatar_url` from that same metadata. `creators.display_name` is tried first, so
a creator gifting another creator shows their chosen name.

The first cut read only `creators.display_name`, which is null for every viewer;
every gift row would have read "ผู้ชม" beside a chat line from the same person
showing their real name.

This is resolved server-side rather than taken from the request: a chat line's
name is its sender's own claim, but a gift is money.

### 8. `gift_stars_total` is additive to `tip_stars_received`, not a replacement

The brief said "If `tip_stars_received` already covers the total, keep it and add
only `gift_count`". `tip_stars_received` exists and is what `live-end-session`
reports as ดาวที่ได้รับ, so gifts add to it — otherwise the summary would
understate the broadcast. `gift_count` and `gift_stars_total` are the gift-only
breakdown beside it, which is what the creator's stats strip and the end-live
summary show as separate lines.

### 9. The OBS overlay key is `creator_overlay_keys`, not `creators.overlay_key`

The brief specified a column on `creators`. It cannot safely live there:

```
creators_public_read  FOR SELECT TO authenticated USING (true)
```

Every signed-in user can read every column of every creator row, so a `select=*`
through PostgREST would hand each of them every creator's overlay key — a
credential that mints a JWT for that creator's user id. Column-level `GRANT`s
could exclude it, but they must then enumerate every *other* column and be
maintained by hand as columns are added.

`public.creator_overlay_keys` has RLS enabled with **no policy** and no client
grant. There is nothing to revoke and no column list to keep in step; the only
paths to a key are `get_creator_overlay_key()` (resolves the caller's own row
from `auth.uid()`, never from an argument) and `resolve_overlay_session()`
(service_role only).

### 10. The OBS link lives on `/creator/live`, not `/settings`

`/settings` is still a `ComingSoon` stub with no shell to hang a card on — and
the overlay URL contains a **session id**, which does not exist until a creator
presses go-live, so a settings page could only ever show half a link. The card
is on the broadcasting screen, where the session is in hand and where a creator
is looking while setting their OBS scene up.

### 11. The fullscreen stage is sized against the overlay, not the viewport

The brief said `min(70vw, 70vh)`. The overlay is mounted inside the *player's*
box — on a desktop layout roughly 70% of the width, with a chat panel beside it
— so a viewport-sized stage overflows it. `useStageScale` measures the actual
container instead, at 70% of its smaller dimension and capped at 720px, which
also gives Phase E's 1080p ceiling for free.

(The scale factor cannot be computed in CSS at all: `scale()` takes a number and
CSS cannot divide a length by a length to produce one.)

### 12. The success toast reuses `FeedbackToast`

The repo has exactly one toast component and its own comments say a second one
should not be added. `ส่งของขวัญแล้ว 🎁` renders through it.

### 13. The fullscreen tiebreak ranks `sort_order` DESCENDING, not ascending

The follow-up brief specifies `price_stars desc, sort_order asc` for the
fullscreen queue. Ascending is wrong for its own QA gate: with every price at 0
it puts Stardust (sort_order 1) ahead of Nova (4), the exact reverse of the
"Nova plays first" behaviour the same brief lists as gate 3. The gate expresses
the intent — the bigger gift goes first — so the tiebreak follows the intent and
ranks downward.

### 14. The bench's production gate is a Server Component

The follow-up brief asked for `process.env.VERCEL_ENV !== 'production'` on
`/dev/gifts`, which was a `'use client'` page. `VERCEL_ENV` is not
`NEXT_PUBLIC_`, so that reference compiles to `undefined` in a client bundle —
and `undefined !== 'production'` is **true**, which would have left the bench
open on production behind a gate that looked correct. The page is now a Server
Component that reads the real value and calls `notFound()`; the client bench
moved to `GiftBench.tsx` beside it.

---

## BLOCKED: the real art has still not reached the repository

The follow-up brief said the CEO had uploaded the reference HTML, the mascot
PNGs and three video clips to `main` in Thai-named folders at the repo root.
**None of it is in the repository.** Checked on 2026-09-03, after `git fetch`:

- `main` is at `199520e` (2026-09-02). No commits after it.
- The GitHub API's listing of the repo root on `refs/heads/main` has 18 entries
  and no Thai-named folder.
- `git ls-tree -r` over **all 42 remote branches**, matching
  `mascot|tier0|stardust|moonlight|comet|nova|IMG_02`: zero hits on every branch
  except this one (whose hits are the placeholder PNGs and the component names).
- The only open PRs are #43 (this one) and #40 (unrelated).

So three sections of that brief could not be started, and nothing about them was
guessed at:

- **§1 relocate** — nothing to `git mv`.
- **§2 port tiers 01–04 from the reference HTML** — no reference HTML, so the
  authored animations stand. They remain authored from the written
  descriptions, not ported.
- **§3 video tiers 05–07** — no clips to probe, re-encode, poster or wire.
  `TierVideoClip` does not exist, `gift_tiers.animation_key` for 5–7 is still
  `generic`, and those tiers still render `TierGenericFloat`.

The placeholder art under `public/gifts/` is therefore still in place, and
`public/gifts/README.md` still documents the contract the real files must meet.

## Things the brief asked for that are deliberately absent

Nothing was dropped by choice. Every item in scope shipped except the three
sections above, which are blocked on files that do not exist. The non-goals
(cross-session leaderboards, gift bundling, per-creator catalogues, refunds,
native sfx/haptics, a CRM price editor) were not built.

---

## What could not be verified in CI, and why

The build environment's egress policy blocks direct HTTPS to the Supabase
project, and there are no test-account credentials available to it. So:

**Verified here, thoroughly:**

- Every `send_live_gift` path, in rolled-back transactions against the real
  database: the happy path (wallet −N, a `live_gift` ledger row with
  `creator_id` set, session counters), `SELF_GIFT`, `INSUFFICIENT_STARS`,
  `QUANTITY_TOO_HIGH`, `SESSION_NOT_LIVE`, the 31st send in a minute, and the
  20,000 stars/minute ceiling.
- That a REFUSED send writes nothing at all — 0 gift rows, 0 ledger rows, 0
  broadcasts, wallet and session counters untouched — with the failed call
  isolated in its own savepoint, which is exactly the rollback a failed RPC gets.
- That the INSERT writes a `realtime.messages` row on `live:<session_id>`, event
  `gift`, private, extension `broadcast`, with the full tier and sender payload.
- Grants: `send_live_gift` and `resolve_overlay_session` are not executable by
  `authenticated` or `anon`; `live_gifts` and `creator_overlay_keys` are not
  insertable or (for the keys) readable by clients.
- `get_advisors(security)` reports nothing on any new object except two entries
  that are the design — see the note at the foot of the overlay-keys migration.
- The whole overlay engine in a real browser via `/dev/gifts`: all five
  animations, combo collapsing (3 sends → one row with ×3), replay
  de-duplication, Nova-before-Comet ordering, tray and fullscreen coexisting
  under a 42-gift flood, and the 375px layout.
- The OBS route: the `?key=` is stripped from the URL before first paint, `html`
  and `body` compute to fully transparent, and an unauthenticated overlay paints
  nothing at all.

**Proven in production since.** A real gift went through the deployed UI at
`2026-09-03T09:38:23Z`, before free preview was applied: Stardust ×1 with a
message, from the viewer account to `porforex599`'s session. Wallet 10 → 9,
`total_spent` 1, one `live_gift` ledger row at −1 with `creator_id` set,
`live_sessions` gift_count 1 / gift_stars_total 1 / tip_stars_received 1, and one
`realtime.messages` broadcast row on the session's topic. That closes the HTTP
surface of `live-send-gift`, the RPC, the ledger, the counters and the broadcast.

**Still needs the two-browser pass**: a gift seen travelling end-to-end over a
live Realtime channel on both screens at once, the creator's stats and
top-gifters against real events, the wallet history line rendering, the end-live
summary, and OBS pointed at a real overlay URL (which also needs the vault
secret above).
