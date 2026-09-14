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
