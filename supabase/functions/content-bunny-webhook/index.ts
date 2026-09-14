/**
 * content-bunny-webhook — Bunny Stream tells us what became of an upload.
 *
 * The creator's browser PUTs the file straight to Bunny (see
 * `content-request-video-upload` and `lib/creator/uploader.ts`); nothing about
 * the encode passes through us. This endpoint is the only way the platform
 * ever learns that a video finished, how long it is, and — the part this file
 * exists for — HOW MANY BYTES IT OCCUPIES.
 *
 * WHY THIS FILE IS NOW IN THE REPO
 *
 * It was not. `content-bunny-webhook` was deployed on 2026-08-31 04:31 and its
 * source lived only in the Supabase dashboard, so nothing here could be read,
 * reviewed or type-checked — and, as it turned out, nothing here could notice
 * that it had stopped working.
 *
 * THE BUG, and it is worth being precise because the shape of it is the whole
 * lesson. Every deploy bundles a SNAPSHOT of the `_shared/` files a function
 * imports (see ../README.md). The bundle this function shipped with carried the
 * `_shared/utils.ts` of 2026-08-31 morning, whose `getVaultSecret` read
 * `vault.decrypted_secrets` over PostgREST:
 *
 *     client.schema('vault').from('decrypted_secrets')...
 *
 * At 11:03 that same morning `content-request-video-upload` was redeployed
 * against a rewritten `_shared/utils.ts` that goes through the
 * `get_vault_secret()` SECURITY DEFINER RPC instead — which is the pattern the
 * rest of this directory has used ever since, because the `vault` schema is not
 * one PostgREST exposes. THIS function was never redeployed. It has been
 * running the dead vault helper for two weeks.
 *
 * And it failed SILENTLY, which is why nobody saw it: the metadata fetch sat
 * inside a `try { } catch { console.error }`, so the throw was logged and
 * discarded, `metadata` stayed `{}`, and the handler went on to answer
 * `200 {"ok":true}`. Bunny was told everything was fine. `video_status` was
 * written, so the video appeared and played — the only trace was three columns
 * that stayed NULL together:
 *
 *     file_size_bytes, duration_seconds, thumbnail_url
 *
 * `file_size_bytes` is the one that costs money to lose. It is the platform's
 * only record of how much storage a creator occupies, so with it NULL the
 * storage line of the infra bill is computed from zero bytes and reads 0 GB
 * however much video is actually sitting in the library. Reproduced on
 * 2026-09-14 by replaying a delivery for the one row in `feed_posts`: HTTP 200,
 * `{"ok":true}`, and all three columns still NULL afterwards.
 *
 * WHAT CHANGED HERE
 *
 *   1. It imports `../_shared/utils.ts` from this repo, so the vault read goes
 *      through the RPC like everything else — and so the next person to change
 *      that module changes this function too, instead of this function quietly
 *      keeping a copy from August.
 *   2. An enrichment failure is no longer silent. See `respond` below.
 *   3. The storage a video adds to its creator's quota is posted as a DELTA
 *      rather than on the status transition, so a retry or a backfill lands the
 *      bytes exactly once even when the first delivery could not read them.
 *
 * SECURITY, unchanged and worth writing down: this function is deployed
 * `--no-verify-jwt` (Bunny cannot mint a Supabase JWT) and Bunny's deliveries
 * are NOT signed here. Anyone who learns a video's GUID can drive this
 * endpoint. Today the worst that buys is publishing a draft the caller already
 * had to know the GUID of, and re-reading sizes from Bunny. That is a real gap
 * and it is not this change's to close — see docs/FOLLOWUPS.md.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getServiceClient,
  getVaultSecrets,
  BUNNY_STREAM_API_BASE,
  fetchWithTimeout,
} from '../_shared/utils.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

/**
 * Bunny's webhook status code → our `feed_posts.video_status`.
 *
 * KEPT EXACTLY AS DEPLOYED, deliberately. Bunny's published webhook enum and
 * the enum on the video object itself do not agree about which number means
 * "finished", and this mapping — 4 is ready, 3 is still processing — is the one
 * that has actually been driving production since August: the row in
 * `feed_posts` reached 'ready', so a 4 really did arrive for a finished encode.
 *
 * Changing it would move WHEN a video becomes visible to viewers, which is a
 * different question from whether its size was recorded, and not one to answer
 * from a doc page while fixing a billing number. Flagged in docs/FOLLOWUPS.md
 * so it gets checked against a real delivery log rather than guessed at.
 */
function mapBunnyStatus(bunnyStatus: number): string {
  switch (bunnyStatus) {
    case 0: return 'pending';
    case 1: return 'uploading';
    case 2: case 3: return 'processing';
    case 4: return 'ready';
    case 5: case 6: return 'failed';
    default: return 'processing';
  }
}

/** What Bunny's `GET /library/{id}/videos/{guid}` gives us that we keep. */
interface BunnyVideo {
  /** Duration in seconds. Bunny's name for it, not ours. */
  length?: number;
  /** Bytes the encoded renditions occupy in the library. THE storage number. */
  storageSize?: number;
  thumbnailFileName?: string;
}

/** The columns a finished encode fills in, once Bunny has been asked. */
interface VideoMetadata {
  duration_seconds: number;
  file_size_bytes: number;
  thumbnail_url: string;
}

interface FeedPostRow {
  id: string;
  creator_id: string;
  video_status: string | null;
  publish_status: string | null;
  file_size_bytes: number | null;
  duration_seconds: number | null;
}

/**
 * Ask Bunny what the finished video actually is.
 *
 * Throws rather than returning null on every failure path, so the caller can
 * tell "Bunny says this video has no size" (which it never does) apart from
 * "we could not ask" — the distinction the old `catch` threw away.
 */
async function fetchVideoMetadata(videoGuid: string): Promise<VideoMetadata> {
  const secrets = await getVaultSecrets([
    'bunny_stream_library_id',
    'bunny_stream_api_key',
    'bunny_stream_cdn_hostname',
  ]);

  const response = await fetchWithTimeout(
    `${BUNNY_STREAM_API_BASE}/${secrets.bunny_stream_library_id}/videos/${videoGuid}`,
    { headers: { AccessKey: secrets.bunny_stream_api_key, accept: 'application/json' } },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Bunny video read failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const video = (await response.json()) as BunnyVideo;

  /**
   * A finished encode always has bytes. `storageSize` missing or zero here
   * means we asked too early or asked about the wrong thing — and writing the
   * zero would be worse than writing nothing, because a zero is indistinguish-
   * able from a real measurement and would never be picked up by the backfill.
   */
  if (!video.storageSize || video.storageSize <= 0) {
    throw new Error(`Bunny reported no storageSize for ${videoGuid}`);
  }

  return {
    duration_seconds: Math.round(video.length ?? 0),
    file_size_bytes: video.storageSize,
    thumbnail_url:
      `https://${secrets.bunny_stream_cdn_hostname}/${videoGuid}/` +
      `${video.thumbnailFileName ?? 'thumbnail.jpg'}`,
  };
}

const BYTES_PER_GB = 1024 ** 3;

/**
 * Move the creator's monthly quota by what this delivery actually added.
 *
 * A DELTA, NOT A SET, and not gated on the status transition — which is the
 * fix for the second half of the silent failure. The old code added
 * `metadata.file_size_bytes` to `total_storage_gb` once, at the moment the
 * video turned 'ready'. When the Bunny read had failed, that "once" added zero
 * and there was no second chance: the video was already 'ready', so no later
 * delivery, retry or backfill would ever post its bytes. The creator's storage
 * stayed 0 GB permanently, which is exactly what every row of
 * `creator_content_quotas` currently reads.
 *
 * Posting `(new - old)` instead makes the write idempotent in the only way
 * that matters: replaying a delivery for a video whose size is already
 * recorded moves the quota by zero, and filling in a size that was missing
 * moves it by the full amount, whenever that happens to occur.
 *
 * `videos_uploaded_count` still increments only on the pending→ready
 * transition. It counts events, not bytes, and a replay must not inflate it.
 */
async function postQuotaDelta(
  supabase: SupabaseClient,
  creatorId: string,
  deltaBytes: number,
  deltaSeconds: number,
  countsAsNewUpload: boolean,
): Promise<void> {
  if (deltaBytes === 0 && deltaSeconds === 0 && !countsAsNewUpload) return;

  const monthKey = new Date()
    .toLocaleString('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' })
    .replace(/(\d{4})-(\d{2}).*/, '$1-$2');

  await supabase.rpc('get_or_create_creator_quota', { p_creator_id: creatorId });

  const { data: quota } = await supabase
    .from('creator_content_quotas')
    .select('videos_uploaded_count, total_video_minutes_uploaded, total_storage_gb')
    .eq('creator_id', creatorId)
    .eq('month_key', monthKey)
    .single();

  if (!quota) {
    console.error('[content-bunny-webhook] no quota row to post to', { creatorId, monthKey });
    return;
  }

  await supabase
    .from('creator_content_quotas')
    .update({
      videos_uploaded_count: (quota.videos_uploaded_count ?? 0) + (countsAsNewUpload ? 1 : 0),
      total_video_minutes_uploaded:
        Number(quota.total_video_minutes_uploaded ?? 0) + deltaSeconds / 60,
      total_storage_gb: Number(quota.total_storage_gb ?? 0) + deltaBytes / BYTES_PER_GB,
      updated_at: new Date().toISOString(),
    })
    .eq('creator_id', creatorId)
    .eq('month_key', monthKey);
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    const payload = await req.json();
    console.log('[content-bunny-webhook] delivery', JSON.stringify(payload));

    if (!payload.VideoGuid) return errorResponse('Missing VideoGuid', 400);

    const supabase = getServiceClient();
    const newStatus = mapBunnyStatus(payload.Status);

    const { data: post, error: postErr } = await supabase
      .from('feed_posts')
      .select('id, creator_id, video_status, publish_status, file_size_bytes, duration_seconds')
      .eq('video_uid', payload.VideoGuid)
      .maybeSingle();

    if (postErr) {
      console.error('[content-bunny-webhook] post lookup failed', postErr);
      return errorResponse('Post lookup failed', 500);
    }
    // A video this platform does not track — a library asset uploaded by hand,
    // or a post deleted since. Bunny must be told to stop retrying, so 200.
    if (!post) {
      console.warn('[content-bunny-webhook] delivery for unknown video', payload.VideoGuid);
      return jsonResponse({ ok: true, message: 'Video not tracked' }, 200);
    }

    const row = post as FeedPostRow;

    /**
     * The size read is attempted whenever Bunny says the encode is done AND we
     * do not already have the bytes — not only on the transition into 'ready'.
     *
     * That second clause is what makes a redelivery repair a row the first
     * delivery could not fill, which is the whole failure this function is
     * being fixed for. Asking again for a row that already has its size would
     * be a Bunny API call for an answer we hold, so it is skipped.
     */
    const wantsMetadata = newStatus === 'ready' && row.file_size_bytes === null;

    let metadata: VideoMetadata | null = null;
    let enrichError: string | null = null;
    if (wantsMetadata) {
      try {
        metadata = await fetchVideoMetadata(payload.VideoGuid);
      } catch (err) {
        enrichError = err instanceof Error ? err.message : 'Unknown error';
        // LOUD. The whole cost of the original bug was that this line did not
        // distinguish itself from noise and the handler answered 200 anyway.
        console.error(
          '[content-bunny-webhook] COULD NOT READ VIDEO SIZE — file_size_bytes will stay NULL',
          { video_guid: payload.VideoGuid, post_id: row.id, error: enrichError },
        );
      }
    }

    const becameReady = newStatus === 'ready' && row.video_status !== 'ready';

    const updateFields: Record<string, unknown> = { video_status: newStatus, ...(metadata ?? {}) };
    if (becameReady && row.publish_status === 'draft') {
      updateFields.publish_status = 'published';
      updateFields.published_at = new Date().toISOString();
    }

    const { error: updateErr } = await supabase
      .from('feed_posts')
      .update(updateFields)
      .eq('id', row.id);

    if (updateErr) {
      console.error('[content-bunny-webhook] post update failed', updateErr);
      return errorResponse('Post update failed', 500);
    }

    // Only after the row is safely written — the quota is bookkeeping, the
    // status is what the creator and viewers can see.
    await postQuotaDelta(
      supabase,
      row.creator_id,
      (metadata?.file_size_bytes ?? row.file_size_bytes ?? 0) - (row.file_size_bytes ?? 0),
      (metadata?.duration_seconds ?? row.duration_seconds ?? 0) - (row.duration_seconds ?? 0),
      becameReady,
    );

    const body = {
      ok: enrichError === null,
      post_id: row.id,
      video_status: newStatus,
      published: updateFields.publish_status === 'published',
      /** Null when nothing needed reading; true/false when it was attempted. */
      enriched: wantsMetadata ? metadata !== null : null,
      ...(enrichError ? { enrich_error: enrichError } : {}),
    };

    /**
     * 502 when the size could not be read, even though the status write
     * succeeded.
     *
     * The status is the half that must never be lost, so it is committed
     * first and unconditionally. What is left is a recoverable gap, and a
     * non-2xx is the only way to say so to the one system that knows this
     * delivery happened. Whether Bunny retries on 502 is Bunny's policy and is
     * NOT relied on here — if it does, the retry repairs the row for free; if
     * it does not, the delivery at least shows up failed in Bunny's dashboard
     * instead of green. The guaranteed backstop is neither: it is
     * `scripts/backfill-feed-post-file-sizes.mjs`.
     */
    return jsonResponse(body, enrichError ? 502 : 200);
  } catch (err) {
    console.error('[content-bunny-webhook] unhandled', err);
    return errorResponse(err instanceof Error ? err.message : 'Unknown error', 500);
  }
});
