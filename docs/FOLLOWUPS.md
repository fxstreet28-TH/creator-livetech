# Follow-ups

Things found and deliberately not fixed, with enough context to pick up cold.
Opened 2026-09-14 during the cost-accuracy work.

---

## Bunny's webhook deliveries are not authenticated

`content-bunny-webhook` is deployed `--no-verify-jwt` (Bunny cannot mint a
Supabase JWT) and verifies no signature of its own. Anyone who knows a video's
GUID can POST a status to it.

Today that buys: publishing a `draft` post whose GUID the caller already had to
know, and causing a re-read of sizes from Bunny. Not nothing, and it gets worse
as soon as the webhook is given anything else to write.

`_shared/utils.ts` already allows an `x-bunny-signature` header through CORS,
which suggests this was intended and never finished. Closing it needs Bunny's
webhook-signing configuration checked first — the header may not be populated at
all on this account.

## The Bunny status→`video_status` mapping is not verified against Bunny

`mapBunnyStatus` treats **4** as finished and **3** as still processing. Bunny's
published webhook enum and the enum on the video object itself do not agree
about which number means "finished", and the 2026-09-14 brief asserted 3.

What is known for certain: the one row in `feed_posts` reached `'ready'`, so a 4
really does arrive for a finished encode on this account. The mapping was left
exactly as deployed rather than changed on the strength of a doc page, because
moving it changes **when a video becomes visible to viewers** — a different
question from whether its size was recorded.

To settle it: read Bunny's webhook delivery log for one upload end to end and
write down the codes actually sent, in order.

## `live-bunny-probe` is a stale bundle

Last deployed 2026-09-07, so it predates the 6 Mbps ceiling (#63), the 1080p
rung (#65) and the `livekit_selfhost` pricing (#70). It does **not** price
anything — it is a read-only diagnostic — so it was left alone. Worth a redeploy
next time anyone touches it, if only so `supabase functions list` stops being
misleading about which bundles are current.

## `creator_content_quotas.videos_uploaded_count` never incremented

Every row reads 0, including for the one video that did upload successfully. The
count is posted from `content-bunny-webhook` on the `pending → ready`
transition, and the August delivery evidently did not take that branch — the
2026-08 quota row's `updated_at` (04:22) predates the upload (11:05). The fixed
webhook still only counts on the transition, which is correct for a counter of
events, so this one historical row stays at 0 unless restated by hand. Not worth
a migration for a single test upload; worth re-checking after the next real one.

## `deno task check` does not cover the `live-*` or `content-*` functions

`supabase/functions/deno.json`'s `check` task lists the signup and wallet
functions only. The functions that price sessions and record storage bytes — the
ones where a type error costs money — are not type-checked by anything. Adding
them needs network access to the remote imports (`esm.sh`, `deno.land`) at check
time, which is presumably why they were left out.

## A repaired row's bytes land in the month of the repair

`content-bunny-webhook` posts the quota delta against `month_key = now`, which
is what it has always done and is right for a live delivery — the upload and the
callback are seconds apart. It is wrong for a repair: the 22.21 MB recovered on
2026-09-14 for a video uploaded on 2026-08-31 landed in the creator's **2026-09**
row, not 2026-08.

`total_storage_gb` sits beside `videos_uploaded_count` and
`total_video_minutes_uploaded`, both of which are plainly per-month flows, so the
honest attribution is the upload's month. The re-derivation SQL that
`scripts/backfill-feed-post-file-sizes.mjs` prints buckets by `feed_posts
.created_at` and would move it. Not run: it is 0.02 GB on one test upload, and
restating a month somebody may have already read is CEO Por's call, not a side
effect of a repair.

## Historical `metadata.cost_breakdown_thb` is still on the old pricing

Sessions closed by `live-watchdog` between 2026-09-07 and 2026-09-14 were priced
by a bundle carrying the 2026-09-07 vintage of `_shared/live.ts`: a flat 3 Mbps
Bunny constant, no per-rung `quality`, no `livekit_selfhost` mode, and the old
`origin_room_id ? 'origin' : 'llhls'` derivation. Their `estimated_cost_thb` and
the `platform_budget_state` totals they posted understate the CDN line by ~2x at
720p and ~3x at 1080p.

**Not rewritten**, deliberately. Those rows are an audit trail that has already
been read, and the quota and budget totals they fed cannot be recomputed from
the rows alone. Restating them is CEO Por's call as a separate, explicit
operation — not a side effect of a fix.

The blast radius is one row: `b4df2bb6-f452-4560-afe1-78ad82974260` (720p,
1 minute, 1 viewer, `cost_breakdown_thb.bunny_cdn = 0` where the current formula
gives 0.01). Understated by ~0.004 THB. It is the mechanism that mattered here,
not this bill.

Rows priced from 2026-09-14 onward carry `cost_breakdown_thb.model`, so the
query that finds the affected ones is now simply: no `model` key.

## Sessions from 2026-09-10 14:11–14:36 UTC were priced as `llhls`

`32691f96-9876-43c7-a5a2-d068d69434e7` and `4131f4b6-7b74-4c8d-876a-d1dfe3b60448`
have no `metadata.delivery_mode` — that field is written only by
`live-create-session` v8, deployed 14:51 UTC — and no `origin_room_id`, so they
fell through to `llhls` and were charged the full LiveKit egress line (2.14 and
2.86 THB) for sessions that were actually on the self-hosted LiveKit.

Same class as the refund already done by hand for
`9595d27e-fc6d-47d0-990f-f521c95fcc0b`. Left alone for the same audit-trail
reason as the entry above; noted so the two are restated together if either is.
