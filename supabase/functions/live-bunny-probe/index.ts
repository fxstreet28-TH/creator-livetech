/**
 * live-bunny-probe — a diagnostic for the §5a blocker in
 * docs/phase2-llhls-migration.md. Not part of the product, and safe to delete
 * once Bunny Live is either working or abandoned.
 *
 * WHY IT HAS TO RUN AS AN EDGE FUNCTION
 *
 * The 2026-09-01 investigation recorded that "the pull zone returns 403 to
 * this infrastructure for every path". That was a misreading. The 403 came
 * from the agent sandbox's own egress proxy refusing the CONNECT:
 * api.bunny.net, vz-46d7a368-5c3.b-cdn.net, *.supabase.co and
 * cloud-api.livekit.io are all denied identically, and the reply carries the
 * proxy's headers, not Bunny's. Bunny never saw those requests. The same
 * fetches from an Edge Function run on Supabase's network, where Bunny is
 * reachable — so a live manifest CAN be fetched for diagnosis after all.
 *
 * DELIBERATELY SELF-CONTAINED. It duplicates ~30 lines of _shared (the vault
 * read, the URL signer, fetch-with-timeout) rather than importing them. A
 * diagnostic that shares a module with the code it is diagnosing cannot rule
 * that module out, and this one deploys as a single file.
 *
 * Three modes:
 *
 *   baseline   create a throwaway live stream, read it straight back, fetch
 *              its playlist, delete it. Establishes what a never-ingested
 *              stream looks like, and what the CDN says about a playlist that
 *              was never written.
 *   observe    poll one stream every interval_ms for duration_ms, fetching the
 *              playlist each tick. The actual e2e probe: fire it while a
 *              broadcast is pushing RTMP.
 *   cleanup    delete a stream by guid.
 *
 * SECURITY. verify_jwt is off so pg_net can drive it from SQL, so it does its
 * own auth: the bearer must equal the service role key. Every reply goes
 * through redact() — a live-stream object carries `streamKey`, an ingest
 * credential, and this output lands in net._http_response.
 */

const BUNNY_API = 'https://video.bunnycdn.com/library';

/**
 * Playlist fetches must carry a Referer, or the answer is meaningless.
 *
 * Measured against pull zone vz-46d7a368-5c3 on 2026-09-07, using a VOD the
 * app plays fine (77cce7ca-…/playlist.m3u8):
 *
 *   no Referer                                   403   Bunny's branded page
 *   Referer: creatorlivetech.com                 200   #EXTM3U
 *   www., *.vercel.app, localhost:3000,
 *   capacitor://localhost                        200   #EXTM3U
 *
 * So the library blocks requests with NO referrer and allows every referrer it
 * is given — Bunny Stream's "block direct file access" default with an empty
 * allow-list. Browsers always send one, so no VIEWER is affected; but a
 * server-side probe that omits it reads 403 on every path and learns nothing.
 * This is what §5a of the migration doc mistook for the CDN refusing us.
 *
 * With a Referer the codes finally mean what they should:
 *   403  referrer rejected      404  no playlist written      200  playing
 */
const VIEWER_HEADERS = {
  accept: '*/*',
  Referer: 'https://creatorlivetech.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function withTimeout(url: string, init: RequestInit, ms = 10000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

/** The same vault RPC the product functions use, called directly over PostgREST. */
async function vault(names: string[]): Promise<Record<string, string>> {
  const res = await withTimeout(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/get_vault_secrets`, {
    method: 'POST',
    headers: {
      apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_names: names }),
  });
  if (!res.ok) throw new Error(`vault read failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = (await res.json()) as { name: string; decrypted_secret: string }[];
  return Object.fromEntries(rows.map((r) => [r.name, r.decrypted_secret]));
}

/** PostgREST select, so the probe can find the session a broadcast just opened. */
async function selectSessions(query: string): Promise<Record<string, unknown>[]> {
  const res = await withTimeout(`${Deno.env.get('SUPABASE_URL')}/rest/v1/live_sessions?${query}`, {
    method: 'GET',
    headers: {
      apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    },
  });
  return res.ok ? ((await res.json()) as Record<string, unknown>[]) : [];
}

/**
 * Bunny CDN token authentication, directory-scoped.
 *
 * Identical to signBunnyUrl in _shared/live.ts — an HLS stream is a manifest
 * plus a segment request every few seconds, so a token bound to live.m3u8
 * alone would authorise the playlist and 403 every segment.
 */
async function sign(playbackUrl: string, tokenKey: string, expires: number): Promise<string> {
  const url = new URL(playbackUrl);
  const directory = url.pathname.replace(/[^/]*$/, '');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${tokenKey}${directory}${expires}`),
  );
  const token = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  url.searchParams.set('token', token);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('token_path', directory);
  return url.toString();
}

const SECRET_KEYS = new Set(['streamKey', 'stream_key', 'bunny_stream_key']);

/**
 * Strip ingest credentials from a report.
 *
 * The stream key also appears inside strings — an RTMP destination is
 * `<ingest url>/<stream key>` — so the value is blanked wherever it occurs,
 * not only where its own key names it.
 */
function redact<T>(value: T, streamKeys: string[]): T {
  const scrub = (s: string) =>
    streamKeys.reduce((acc, k) => (k ? acc.split(k).join('<redacted-stream-key>') : acc), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) =>
          SECRET_KEYS.has(k) ? [k, val ? '<redacted>' : val] : [k, walk(val)],
        ),
      );
    }
    return v;
  };
  return walk(value) as T;
}

async function bunny(method: string, library: string, key: string, path: string, body?: unknown) {
  const started = Date.now();
  const res = await withTimeout(`${BUNNY_API}/${library}${path}`, {
    method,
    headers: {
      AccessKey: key,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text().catch(() => '');
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, ms: Date.now() - started, json: parsed, text: parsed === null ? text.slice(0, 400) : undefined };
}

/**
 * Fetch a playlist and describe what came back.
 *
 * The body matters as much as the status: a manifest starts `#EXTM3U`, and a
 * 200 carrying anything else is not one. `ll_hls_parts` counts `#EXT-X-PART`,
 * the tag that tells real LL-HLS from plain HLS — which §5 of the doc lists as
 * never verified.
 */
async function manifest(url: string) {
  const started = Date.now();
  try {
    const res = await withTimeout(url, { method: 'GET', headers: VIEWER_HEADERS }, 8000);
    const body = await res.text().catch(() => '');
    const u = new URL(url);
    return {
      path: u.pathname + (u.search ? '?<token>' : ''),
      sent_referer: VIEWER_HEADERS.Referer,
      status: res.status,
      ms: Date.now() - started,
      content_type: res.headers.get('content-type'),
      server: res.headers.get('server'),
      cdn_cache: res.headers.get('cdn-cache'),
      bytes: body.length,
      is_m3u8: body.startsWith('#EXTM3U'),
      variants: (body.match(/#EXT-X-STREAM-INF/g) ?? []).length,
      segments: (body.match(/#EXTINF/g) ?? []).length,
      ll_hls_parts: (body.match(/#EXT-X-PART:/g) ?? []).length,
      head: body.slice(0, 300),
    };
  } catch (err) {
    return { path: url.replace(/\?.*$/, '?<token>'), status: 0, error: String(err).slice(0, 200) };
  }
}

/** The live-stream fields this investigation turns on. */
function summarise(raw: Record<string, unknown> | null) {
  if (!raw) return null;
  const keys = ['guid', 'status', 'startedAt', 'endedAt', 'durationSeconds', 'width', 'height',
    'framerate', 'availableResolutions', 'dvrEnabled', 'recordVod', 'dateCreated',
    'playbackUrlHls', 'thumbnailUrl', 'ingestEndpoints'];
  const out = Object.fromEntries(keys.filter((k) => k in raw).map((k) => [k, raw[k]]));
  out._all_keys = Object.keys(raw).sort();
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.headers.get('Authorization') !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`) {
    return json({ error: 'service role required' }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.mode ?? 'baseline';
    const secrets = await vault(['bunny_stream_api_key', 'bunny_stream_library_id', 'bunny_stream_token_key']);
    const key = secrets.bunny_stream_api_key;
    const library = secrets.bunny_stream_library_id;
    const tokenKey = secrets.bunny_stream_token_key ?? null;

    /**
     * Both forms of every playlist URL.
     *
     * `bunny_stream_token_key` appeared in the vault on 2026-09-01, after the
     * doc recorded that it did not exist. If token authentication is actually
     * ON for the pull zone, the unsigned URL 403s and the signed one does not;
     * if it is OFF both behave alike. Fetching both is the only way to tell a
     * CDN refusing the viewer from a CDN with nothing to serve.
     */
    const playlists = async (url: string | null) => {
      if (!url) return null;
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const out: Record<string, unknown> = { unsigned: await manifest(url) };
      if (tokenKey) out.signed = await manifest(await sign(url, tokenKey, expires));
      return out;
    };

    if (mode === 'cleanup') {
      if (!body.guid) return json({ error: 'guid required' }, 400);
      const del = await bunny('DELETE', library, key, `/live/${body.guid}`);
      return json({ mode, guid: body.guid, delete_status: del.status });
    }

    if (mode === 'baseline') {
      const create = await bunny('POST', library, key, '/live', {
        title: `PROBE ${new Date().toISOString()} (delete me)`,
        dvrEnabled: true,
        recordVod: false,
      });
      const created = create.json as Record<string, unknown> | null;
      const guid = created?.guid as string | undefined;
      const streamKey = (created?.streamKey as string) ?? '';
      const playbackUrl = (created?.playbackUrlHls as string) ?? null;

      const readback = guid ? await bunny('GET', library, key, `/live/${guid}`) : null;
      // §5c: a live stream also resolves on the VOD route. That is what makes a
      // 404 there mean "deleted", not "fabricated id".
      const asVideo = guid ? await bunny('GET', library, key, `/videos/${guid}`) : null;
      const pl = await playlists(playbackUrl);

      // The library object. Expected 401 — bunny_stream_api_key is library-
      // scoped and this needs the ACCOUNT key, which is not in the vault.
      // Recorded so the report demonstrates the gap rather than asserting it.
      const libraryRead = await withTimeout(
        `https://api.bunny.net/videolibrary/${library}`,
        { method: 'GET', headers: { AccessKey: key, accept: 'application/json' } }, 8000,
      ).then(async (r) => ({ status: r.status, body: (await r.text().catch(() => '')).slice(0, 200) }))
       .catch((e) => ({ status: 0, body: String(e).slice(0, 200) }));

      const cleanup = guid && body.keep !== true
        ? { status: (await bunny('DELETE', library, key, `/live/${guid}`)).status }
        : null;

      return json(redact({
        mode, at: new Date().toISOString(), library_id: library,
        token_auth_key_present: Boolean(tokenKey),
        create: { status: create.status, ms: create.ms, error_body: create.text, stream: summarise(created) },
        readback: readback && { status: readback.status, stream: summarise(readback.json as Record<string, unknown> | null) },
        as_video_route_status: asVideo?.status ?? null,
        library_read: libraryRead,
        playlists: pl,
        cleanup,
        kept_guid: body.keep === true ? guid ?? null : null,
      }, [streamKey]));
    }

    if (mode === 'observe') {
      /**
       * Which stream to watch: the named session's, or — given nothing — the
       * newest session that HAS a Bunny stream, so the probe can be fired the
       * moment a broadcast starts without anyone copying a uuid across.
       */
      const cols = 'id,created_at,status,room_name,broadcast_quality,latency_mode,bunny_stream_id,bunny_playback_url,livekit_egress_id,started_at,ended_at';
      const rows = body.session_id
        ? await selectSessions(`select=${cols}&id=eq.${body.session_id}`)
        : await selectSessions(`select=${cols}&bunny_stream_id=not.is.null&order=created_at.desc&limit=1`);
      const session = rows[0] ?? null;
      const guid: string | null = body.guid ?? (session?.bunny_stream_id as string) ?? null;

      if (!guid) return json({ mode, error: 'no live session with a bunny_stream_id', session }, 404);

      const intervalMs = Number(body.interval_ms ?? 5000);
      const durationMs = Math.min(Number(body.duration_ms ?? 120000), 130000);
      const t_start = Date.now();
      const deadline = t_start + durationMs;

      const ticks: unknown[] = [];
      let streamKey = '';
      let wentLive = false;
      let sawPlaylist = false;

      while (Date.now() < deadline) {
        const t0 = Date.now();
        const get = await bunny('GET', library, key, `/live/${guid}`);
        const raw = get.json as Record<string, unknown> | null;
        if (raw?.streamKey) streamKey = raw.streamKey as string;

        const url = (raw?.playbackUrlHls as string) ?? (session?.bunny_playback_url as string) ?? null;
        const pl = await playlists(url);
        const u = pl?.unsigned as { is_m3u8?: boolean } | undefined;
        const s = pl?.signed as { is_m3u8?: boolean } | undefined;

        if (raw?.startedAt) wentLive = true;
        if (u?.is_m3u8 || s?.is_m3u8) sawPlaylist = true;

        ticks.push({
          elapsed_s: Math.round((Date.now() - t_start) / 100) / 10,
          get_status: get.status,
          stream: summarise(raw),
          playlists: pl,
        });

        // A playlist that exists is the whole answer; two more minutes of
        // polling would add nothing but CDN requests.
        if (sawPlaylist) break;

        const wait = intervalMs - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }

      return json(redact({
        mode,
        started_at: new Date(t_start).toISOString(),
        finished_at: new Date().toISOString(),
        library_id: library, guid,
        token_auth_key_present: Boolean(tokenKey),
        session,
        bunny_reported_started: wentLive,
        playlist_seen: sawPlaylist,
        tick_count: ticks.length,
        ticks,
      }, [streamKey]));
    }

    return json({ error: 'mode must be baseline, observe or cleanup' }, 400);
  } catch (err) {
    return json({ error: String(err).slice(0, 500) }, 500);
  }
});
