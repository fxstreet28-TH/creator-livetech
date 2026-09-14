# Where a video's size comes from, and what reads it

Written 2026-09-14, after `feed_posts.file_size_bytes` was found NULL for every
row in the table.

## The number

`feed_posts.file_size_bytes` is the platform's **only** record of how many bytes
a creator's videos occupy. Nothing recomputes it, nothing else stores it, and
nothing notices when it is missing. Downstream it feeds:

- `creator_content_quotas.total_storage_gb`, the per-creator monthly rollup;
- the storage line of the infra cost estimate, which is `total_storage_gb ×` the
  Bunny storage rate — so a NULL is not "unknown", it silently reads as **zero
  baht of storage**;
- the storage-bloat alert, which can never fire against zero.

## How it is supposed to arrive

The file never touches our servers. The browser PUTs it straight to Bunny:

```
/creator/upload
  → content-request-video-upload      creates the Bunny video, inserts the
                                      feed_posts row with video_status='pending'
  → browser PUT to video.bunnycdn.com (lib/creator/uploader.ts)
  → Bunny encodes
  → POST /functions/v1/content-bunny-webhook   Status=4
        ├── feed_posts.video_status = 'ready'
        └── GET /library/{id}/videos/{guid}  ← storageSize lives ONLY here
                 └── feed_posts.file_size_bytes, duration_seconds, thumbnail_url
```

**The webhook body does not contain the size.** Bunny's status callback carries
`VideoGuid` and `Status` and nothing about bytes, so the second call to
`GET /library/{id}/videos/{guid}` is not an optimisation — it is the only place
`storageSize` exists. If that call does not happen, or fails, the size is gone
and no later event brings it back on its own.

## How it actually went (2026-08-31 → 2026-09-14)

`content-bunny-webhook` was deployed on 2026-08-31 at 04:31 and never again. Its
bundled `_shared/utils.ts` snapshot read the vault directly over PostgREST:

```ts
client.schema('vault').from('decrypted_secrets')   // the vault schema is not exposed
```

At 11:03 the same morning `content-request-video-upload` was redeployed against
a rewritten `_shared/utils.ts` that goes through the `get_vault_secret()`
SECURITY DEFINER RPC. That is the pattern every function in this directory has
used since. The webhook kept the August copy, because a deploy bundles a
snapshot of `_shared/` per function (see `supabase/functions/README.md`).

So every Bunny read threw on the vault lookup — and the throw was caught, logged
and discarded, after which the handler answered `200 {"ok":true}`. Bunny saw a
green delivery. The video appeared and played, because `video_status` was
written before the enrichment. The only symptom was three columns that were
always NULL **together**: `file_size_bytes`, `duration_seconds`, `thumbnail_url`.

Reproduced on 2026-09-14 by replaying a delivery for the one row in the table:
HTTP 200, `{"ok":true,"video_status":"ready"}`, all three still NULL.

## What now guards it

1. The function lives in this repo and imports `../_shared/utils.ts`, so it
   cannot keep a private vintage of the vault helper.
2. A failed size read is **loud**: a distinct `COULD NOT READ VIDEO SIZE` log
   line, `enrich_error` in the response body, and a 502 rather than a 200, so
   the delivery shows up failed in Bunny's dashboard instead of green.
3. The read is retried on any later delivery for a row whose `file_size_bytes`
   is still NULL — not only on the transition into `ready`.
4. The quota storage line is posted as a **delta**, so whenever the bytes do
   arrive — first delivery, redelivery or backfill — they land exactly once.
   Previously it was added on the status transition only, so a video whose size
   failed to read counted as 0 GB permanently.
5. `scripts/backfill-feed-post-file-sizes.mjs` sweeps up rows Bunny will never
   redeliver for. One-shot; see its header.

## What is still not guarded

Nothing verifies Bunny's webhook signature — see `docs/FOLLOWUPS.md`.
