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

### 1. The art arrived on a GitHub release, not in the repository

The brief listed four reference HTML cards under `docs/gift-cards/` and mascot
PNGs under `public/gifts/`, to be committed before the work started. They were
not there — not on `main`, not on any of the 42 remote branches, not in the
history — and three later attempts to deliver them (Thai-named folders on
`main`, an `incoming-gift-assets/` directory on this branch, two zips attached
to a PR comment) each turned out to carry nothing this session could read. The
PR-comment route failed on the agent egress proxy rather than on GitHub: it
answers `github.com/{owner}/{repo}/releases/download/...` and refuses
`user-attachments`.

They finally arrived as a **GitHub release, tag `gift-assets-v1`**, and
everything in this feature's `§1`-`§3` was built from those files. Until then the
four animations were authored from the written descriptions and the mascot
layers were generated placeholders; both are now gone, replaced by the real
thing. Nothing was guessed at in the interval and nothing invented was kept.

### 1a. What the 1:1 port changed, and why

`§2` asked for the keyframes verbatim, with only `infinite` → `1` + `forwards`.
Four things had to differ, and each is marked `PORT` in the module it appears
in:

- **Stardust's arm wave is a bug fix.** The card selects it with
  `.playing .playing .mascot-arm` — a doubled class that matches nothing — so
  the wave never plays in the reference as delivered. The port uses a single
  `.playing`. Worth fixing in the card too.
- **Two sub-loops keep `infinite`.** Moonlight's 16-star glitter field and
  Nova's 0.18s meteor flicker are not on the master timeline: each glitter star
  has its own `--t` and a negative `--d`, and the flicker is fire. Running them
  once freezes them for the rest of the gift.
- **`Math.random()` becomes a fixed-seed mulberry32.** Comet's 40 star dots and
  14 warp streaks, and Nova's 45 sky dots, are scattered randomly in the cards.
  These components render on the server too, and a scatter that disagrees
  between the two renders hydrates with a mismatch on every gift.
- **The speech bubbles inherit the app's Thai face** instead of pulling Kanit
  from Google Fonts. An overlay that fetches a webfont mid-broadcast shows an
  empty bubble until it lands.

Two ids that were literals in the cards — Comet's lens clip-path, Nova's rock
gradient — go through `useId`, because ids are document-global and a tray Comet
under a fullscreen one would otherwise share one and lose it when either
unmounted.

`--cycle` is the tier's own `duration_ms` rather than each card's fixed value.
The seeded rows are already 4500 / 5500 / 6500 / 10000, so the timing is
identical today and stays coherent if the CEO changes one.

### 1b. Tiers 05-07 ship a WebM as well as an MP4, and the WebM is not for size

`§3` asked for H.264 plus a VP9 WebM. On this footage VP9 is **worse per byte**,
measured rather than assumed: on tier 07 x264 scores SSIM 0.928 against the
source at 3.33 MB where VP9 scores 0.877 at 3.66 MB. On size alone the WebM
would have been dropped.

It ships because open-source Chromium builds have **no H.264 decoder** —
`canPlayType('video/mp4; codecs="avc1…")` returns empty and the element fails
with `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` — and the OBS browser source a creator
points at `/overlay/live/[sessionId]` is a Chromium embed. Without the VP9
fallback the three most expensive gifts on the board would degrade to a still
image on the creator's own stream, silently and with no error anywhere. The MP4
is listed first, so browsers that can decode it get the smaller, sharper file.

This also surfaced a real bug: React routes a child `<source>`'s error event to
the parent's `onError`, so the ordinary MP4-rejected-then-WebM path looked like
total failure and tore the video out mid-fallback, leaving the poster. The
handler now only trusts an error whose `target` IS the video element.

### 1c. The duration ceilings moved, and 42 seconds is a product question

`duration_ms` is meant to be how long a gift is on screen, and for the video
tiers that is the clip: 14.933s, 19.900s, 42.233s. Two ceilings blocked that —
the `CHECK` on `gift_tiers.duration_ms` topped out at 30000 and the client clamp
in `lib/live/gifts.ts` at 15000, both guesses made before any clip existed. Both
are now 45000, and each says in a comment that it mirrors the other.

**This is a ceiling, not an endorsement.** A fullscreen gift covers the
creator's video and blocks every fullscreen gift behind it for its full
duration. Forty-two seconds is a long time to take a broadcast away from the
person running it, and a shorter cut of tier 07 would very likely play better.
The number shipped is what the delivered clip measures; trimming it is the CEO's
call.

### 1d. The "AI生成" watermark, measured and removed

All three source clips have `AI生成` ("AI-generated") burned into the bottom-left
corner. The first encode kept it, because stripping an AI-disclosure label off
artwork is not a call to make inside an encoding step. The CEO has since
confirmed these are our own delivered assets and approved removing it.

The box was measured, not eyeballed. Taking the **per-pixel minimum** across
frames spread over each clip isolates it exactly: the watermark is an additive
overlay that never goes away, so under it the minimum stays lifted even when the
scene behind goes dark, while background pixels bottom out. That resolves the
glyphs cleanly enough to print as ASCII and read the bounding box off:

| Clip | Source frame | Glyph box | delogo box (4-5px of pad) |
|---|---|---|---|
| tier-05 | 848×464 | x=7 y=439 w=45 h=14 | `x=3:y=435:w=54:h=22` |
| tier-06 | 848×464 | x=7 y=439 w=45 h=14 | `x=3:y=435:w=54:h=22` |
| tier-07 | 848×560 | x=10 y=536 w=52 h=14 | `x=6:y=532:w=60:h=22` |

`delogo` runs at **source** resolution, ahead of the downscale — that is the
space the box was measured in, and scaling afterwards blends the patched region
further. Frame size, frame count and duration are untouched: 720×394 / 720×394 /
720×476, 448 / 597 / 1267 frames, 14.933333s / 19.900000s / 42.233333s, so no
`duration_ms` moved.

Crop-and-rescale was the stated fallback and was **not** needed. delogo leaves a
faint vertical striping inside the box on the busiest frames — visible if you
zoom the corner to 3×, invisible at the size the clip is actually drawn — and
cropping would have cost real framing on every side of every frame to fix
something no viewer can see.

Re-running the same detector against the shipped clips: **0** persistently-lit
pixels inside the old footprint on tier-05 and tier-07, and on tier-06 only a
bright ice reflection clipping the box's right edge, with no glyph structure
anywhere.

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

## Asset inventory

Everything under `public/gifts/` and `docs/gift-cards/`, as committed:

| Path | Bytes | What it is |
|---|---:|---|
| `docs/gift-cards/aurum-live-tier01-stardust.html` | 669,294 | Reference card, data URIs intact |
| `docs/gift-cards/aurum-live-tier02-moonlight.html` | 382,651 | Reference card |
| `docs/gift-cards/aurum-live-tier03-comet.html` | 747,270 | Reference card |
| `docs/gift-cards/aurum-live-tier04-nova.html` | 469,236 | Reference card |
| `docs/gift-cards/reference/tier04.mp4` | 445,479 | How tier 04 should read in motion. Re-encoded to 480p — it is documentation for a CSS animation, and 4.1 MB to say "like this" was not a good trade. Not served. |
| `public/gifts/tier-01/body.png` | 262,369 | |
| `public/gifts/tier-01/arm.png` | 238,928 | Waves about the shoulder at `68.4% 63.8%` |
| `public/gifts/tier-02/body.png` | 272,796 | |
| `public/gifts/tier-02/eyelid.png` | 14,167 | 27px skin patch over the right eye |
| `public/gifts/tier-03/body.png` | 309,504 | |
| `public/gifts/tier-03/tail.png` | 249,093 | The comet WITH the mascot in it |
| `public/gifts/tier-04/body.png` | 342,520 | |
| `public/gifts/tier-05/clip.mp4` | 1,337,477 | 14.933s, 720×394 |
| `public/gifts/tier-05/clip.webm` | 1,686,610 | |
| `public/gifts/tier-05/poster.jpg` | 33,377 | frame at 8.960s |
| `public/gifts/tier-06/clip.mp4` | 1,152,515 | 19.900s, 720×394 |
| `public/gifts/tier-06/clip.webm` | 1,412,358 | |
| `public/gifts/tier-06/poster.jpg` | 49,957 | frame at 11.940s |
| `public/gifts/tier-07/clip.mp4` | 3,320,344 | 42.233s, 720×476 |
| `public/gifts/tier-07/clip.webm` | 4,208,457 | |
| `public/gifts/tier-07/poster.jpg` | 32,368 | frame at 25.340s |

Encode settings: `delogo` (see 1d), then `scale=720:-2:flags=lanczos`, no audio,
x264 CRF 32 preset slow `-movflags +faststart`, libvpx-vp9 CRF 46
`-b:v 0 -row-mt 1 -cpu-used 2`. The PNGs are committed byte-for-byte as
delivered — re-encoding them at maximum PNG effort makes them *larger*.

The checked-out tree is **23 MB**, under the 25 MB the brief set. `.git` is 31 MB
because it also holds the placeholder blobs this branch deleted; that is history,
not checkout weight.

## Things the brief asked for that are deliberately absent

Nothing was dropped by choice. Every item in both briefs shipped. The non-goals
(cross-session leaderboards, gift bundling, per-creator catalogues, refunds,
native sfx/haptics, a CRM price editor) were not built.

One thing the brief asked for is present but rendered moot: the placeholder
mascot art and the throwaway script that produced it are gone. There was no
`gen_gifts.py` to delete — the placeholders came from a script that was never
committed, only its output was.

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
- The whole overlay engine in a real browser via `/dev/gifts`. Re-run in full
  after the art landed: all seven tiers mid-animation on the fullscreen stage,
  combo collapsing (3 sends → one row reading ×3), replay de-duplication (a
  repeated `gift_id` still one row at ×1), Nova-before-Comet ordering (Nova
  sent 120ms later still plays first), a 42-gift flood holding the tray at its
  3-row cap with no page errors, the 375px layout with no horizontal overflow
  and the sender name un-truncated, and `prefers-reduced-motion: reduce` — zero
  running animations, and a video tier rendering its poster with no `<video>`
  element at all.
- The video fallback chain, watched working: the MP4 `<source>` rejected for
  want of an H.264 decoder, the WebM loading at 720×394, `muted` and playing.
- `send_live_gift` against the new video tiers, in a rolled-back transaction:
  tier 07 free is `stars_total=0` with the wallet untouched at 9 and
  `duration_ms=42233` surviving the new CHECK; the same tier repriced to 4 and
  sent ×2 is `stars_total=8` with the wallet 9 → 1, session counters
  count=2 / stars=8, two broadcast rows on `live:<session>`, and exactly ONE
  `star_transactions` row — the free send writes no ledger entry. Nothing
  persisted: 0 QA sessions left, `live_gifts` still at 1.
- `npm run build`, `tsc --noEmit` and `eslint` all clean over everything this
  PR touches. The four remaining repo-wide lint errors are in
  `app/creator/apply`, `app/explore` and `send-transactional-email`, none of
  which this PR goes near.
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
