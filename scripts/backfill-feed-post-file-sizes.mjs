/**
 * ONE-SHOT BACKFILL — fill `feed_posts.file_size_bytes` from Bunny Stream.
 *
 * Run it once, confirm the count, and do not schedule it. It exists because
 * `content-bunny-webhook` spent 2026-08-31 to 2026-09-14 unable to read the
 * vault, so every video it marked 'ready' had its size, duration and thumbnail
 * silently dropped (see that function's header for the full story). The webhook
 * is fixed and repairs a row the moment Bunny redelivers for it — but Bunny
 * does not redeliver for a video that finished a fortnight ago, so the rows
 * already on the floor have to be swept up by hand. This is the broom.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service role key> \
 *   node scripts/backfill-feed-post-file-sizes.mjs --dry-run
 *
 * Drop `--dry-run` to write. `--limit=N` caps the batch.
 *
 * NO NEW DEPENDENCY, same rule as the dev-bench scripts next to it: Node 22
 * has a global `fetch`, PostgREST is HTTP with a header, and Bunny's API is
 * HTTP with a header. Nothing here needs an SDK.
 *
 * THE BUNNY CREDENTIALS ARE NOT PASSED IN. They are read from the vault through
 * `get_vault_secrets()`, the same RPC every edge function uses, so running this
 * needs no key that is not already the service role's to fetch — and so a
 * rotated Bunny key does not turn into a stale value in somebody's shell
 * history.
 *
 * RATE LIMITED, because Bunny's API is metered and a library is not free to
 * enumerate. One request every SLEEP_MS with no concurrency: this is a repair
 * job measured in rows, not a pipeline, and finishing it a minute sooner is
 * worth nothing.
 *
 * IDEMPOTENT. Only rows with `file_size_bytes IS NULL` are candidates, and the
 * write sets exactly the columns that were missing. Running it twice does the
 * same work as running it once. It deliberately does NOT touch
 * `creator_content_quotas`: re-posting storage from here would double-count
 * against the delta the webhook already posts. After this run, the quota totals
 * are re-derived from `feed_posts` — the SQL to do that is printed at the end.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
/** Bunny's own docs ask for courtesy, not a number; 1/s is plainly courteous. */
const SLEEP_MS = Number(process.env.SLEEP_MS ?? 1000);
const BUNNY_API_BASE = 'https://video.bunnycdn.com/library';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 500);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function rest(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : await response.json();
}

async function main() {
  const secretRows = await rest('rpc/get_vault_secrets', {
    method: 'POST',
    body: JSON.stringify({
      p_names: ['bunny_stream_library_id', 'bunny_stream_api_key', 'bunny_stream_cdn_hostname'],
    }),
  });
  const secrets = Object.fromEntries(secretRows.map((r) => [r.name, r.decrypted_secret]));
  for (const name of ['bunny_stream_library_id', 'bunny_stream_api_key']) {
    if (!secrets[name]) throw new Error(`Vault secret missing: ${name}`);
  }

  /**
   * `video_uid` is the Bunny GUID — the column is named for the provider-
   * agnostic "uid", not for Bunny's own "guid", which is worth knowing before
   * writing a WHERE clause against a column that does not exist.
   */
  const candidates = await rest(
    'feed_posts?select=id,video_uid,duration_seconds,thumbnail_url' +
      '&file_size_bytes=is.null&video_uid=not.is.null' +
      `&order=created_at.asc&limit=${LIMIT}`,
  );

  console.log(`${candidates.length} post(s) with no file_size_bytes and a Bunny video id.`);
  if (candidates.length === 0) return;

  let filled = 0;
  const failures = [];

  for (const [index, post] of candidates.entries()) {
    if (index > 0) await sleep(SLEEP_MS);
    try {
      const response = await fetch(
        `${BUNNY_API_BASE}/${secrets.bunny_stream_library_id}/videos/${post.video_uid}`,
        { headers: { AccessKey: secrets.bunny_stream_api_key, accept: 'application/json' } },
      );

      // 404 is the expected shape of an old test row: the post outlived the
      // asset. Recorded, not retried — there is nothing left in the library to
      // measure.
      if (response.status === 404) {
        failures.push({ id: post.id, guid: post.video_uid, reason: 'gone from Bunny library' });
        continue;
      }
      if (!response.ok) {
        failures.push({ id: post.id, guid: post.video_uid, reason: `HTTP ${response.status}` });
        continue;
      }

      const video = await response.json();
      if (!video.storageSize || video.storageSize <= 0) {
        failures.push({ id: post.id, guid: post.video_uid, reason: 'no storageSize' });
        continue;
      }

      // Only ever fills gaps. A duration or thumbnail that somebody has since
      // set by hand is left exactly as it is.
      const patch = { file_size_bytes: video.storageSize };
      if (post.duration_seconds === null && video.length) {
        patch.duration_seconds = Math.round(video.length);
      }
      if (post.thumbnail_url === null && secrets.bunny_stream_cdn_hostname) {
        patch.thumbnail_url =
          `https://${secrets.bunny_stream_cdn_hostname}/${post.video_uid}/` +
          `${video.thumbnailFileName ?? 'thumbnail.jpg'}`;
      }

      console.log(
        `${DRY_RUN ? '[dry-run] ' : ''}${post.id} ← ` +
          `${(video.storageSize / 1024 ** 2).toFixed(1)} MB`,
      );

      if (!DRY_RUN) {
        await rest(`feed_posts?id=eq.${post.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        });
      }
      filled += 1;
    } catch (err) {
      failures.push({ id: post.id, guid: post.video_uid, reason: String(err) });
    }
  }

  console.log(
    `\n${DRY_RUN ? 'would fill' : 'filled'}: ${filled}/${candidates.length}` +
      ` (${((filled / candidates.length) * 100).toFixed(0)}%)`,
  );
  if (failures.length) {
    console.log(`could not fill ${failures.length}:`);
    for (const f of failures) console.log(`  ${f.id} (${f.guid}): ${f.reason}`);
  }

  if (!DRY_RUN && filled > 0) {
    console.log(
      '\nNow re-derive the storage quota totals from feed_posts, which this\n' +
        'script deliberately did not touch:\n\n' +
        "  update creator_content_quotas q set total_storage_gb = coalesce((\n" +
        '    select sum(p.file_size_bytes)::numeric / 1024^3 from feed_posts p\n' +
        '    where p.creator_id = q.creator_id\n' +
        "      and to_char(p.created_at at time zone 'Asia/Bangkok', 'YYYY-MM') = q.month_key\n" +
        '  ), 0);\n',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
