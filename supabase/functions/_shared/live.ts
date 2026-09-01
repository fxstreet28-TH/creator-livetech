/**
 * Everything the three `live-*` Edge Functions need to talk to Bunny Live and
 * to LiveKit's server APIs, plus the cost model the budget lines are built on.
 *
 * WHY THE PIPELINE HAS TWO VENDORS IN IT
 *
 * Bunny Live has no WHIP ingest. Verified against library 740127 on
 * 2026-09-01: creating a live stream answers
 *
 *   "ingestEndpoints": { "rtmp": { "primaryIngestUrl": "rtmp://global.rtmp…" } }
 *
 * and `/whip/{library}` is a 404. A browser cannot open an RTMP connection —
 * it needs a raw TCP socket — so "creator publishes straight to Bunny from the
 * page" is not available at any price. What IS available, and what this module
 * wires up, is:
 *
 *   creator's browser --WebRTC--> LiveKit room --RoomComposite egress--> RTMP
 *     --> Bunny Live --transcode--> LL-HLS on the CDN --> every viewer
 *
 * The creator still goes live from a browser tab with no OBS, and the viewers —
 * who are the entire cost problem — are served by a CDN at $0.005/GB instead of
 * an SFU at $0.12/GB. The egress is the price of the bridge and it is a flat
 * per-stream cost, not a per-viewer one.
 */

import { BUNNY_STREAM_API_BASE, fetchWithTimeout } from './utils.ts';

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------
//
// These replace the old `peakViewers * minutes * 0.0003 * 35`, which priced
// every viewer as a WebRTC participant. Under the hybrid the bill splits in
// two, and the split is the whole point of the migration: one line is flat per
// stream, the other is the cheap one that scales with the audience.

/** USD→THB. Same rate the pre-migration estimate used, kept for comparability. */
export const THB_PER_USD = 35;

/**
 * LiveKit, per stream-minute — and NOT per viewer-minute any more.
 *
 * $0.015/min RoomComposite video egress, plus two participant connections at
 * $0.0005/min (the publisher, and the egress worker which joins as one).
 */
export const LIVEKIT_THB_PER_STREAM_MINUTE = (0.015 + 2 * 0.0005) * THB_PER_USD;

/**
 * Bunny CDN, per viewer-minute.
 *
 * 720p at ~3 Mbps is 22.5 MB/minute; APAC volume tier is $0.005/GB. This is
 * the number the whole migration was for: ~0.0039 THB against the 0.0377
 * THB/viewer-minute the old model charged.
 */
export const BUNNY_LIVE_THB_PER_VIEWER_MINUTE = ((3 * 60) / 8 / 1024) * 0.005 * THB_PER_USD;

export interface LiveCostBreakdown {
  livekitThb: number;
  bunnyThb: number;
  totalThb: number;
}

/**
 * What one finished session cost.
 *
 * Peak viewers rather than an average: it is the only audience number the
 * platform actually records (see persistViewerCounts on the client), and
 * over-estimating the bill is the safe direction for a budget kill switch.
 */
export function estimateLiveCost(durationMinutes: number, peakViewers: number): LiveCostBreakdown {
  const livekitThb = durationMinutes * LIVEKIT_THB_PER_STREAM_MINUTE;
  const bunnyThb = durationMinutes * peakViewers * BUNNY_LIVE_THB_PER_VIEWER_MINUTE;
  return { livekitThb, bunnyThb, totalThb: livekitThb + bunnyThb };
}

// ---------------------------------------------------------------------------
// Bunny Live
// ---------------------------------------------------------------------------

/** The subset of Bunny's live-stream object this platform uses. */
export interface BunnyLiveStream {
  guid: string;
  title: string;
  /** SECURITY: an ingest credential. Stored service-role-only, never returned to a client. */
  streamKey: string;
  playbackUrlHls: string;
  thumbnailUrl: string | null;
  ingestEndpoints?: {
    rtmp?: { primaryIngestUrl?: string; backupIngestUrl?: string };
  };
}

export interface BunnyLiveCreateOptions {
  /** Keep the DVR window so a viewer joining late can start near the live edge. */
  dvrEnabled?: boolean;
  /** Bunny turns the finished broadcast into a VOD asset when true. */
  recordVod?: boolean;
}

async function bunnyRequest(
  method: string,
  libraryId: string,
  apiKey: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await fetchWithTimeout(`${BUNNY_STREAM_API_BASE}/${libraryId}${path}`, {
    method,
    headers: {
      AccessKey: apiKey,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Create the Bunny live stream a broadcast will be delivered through.
 *
 * `recordVod` is what turns a finished live into a VOD asset, and it has to be
 * decided HERE — Bunny cannot start recording a stream retroactively, so
 * live-end-session can only report the asset, never ask for one.
 */
export async function bunnyCreateLiveStream(
  libraryId: string,
  apiKey: string,
  title: string,
  options: BunnyLiveCreateOptions = {},
): Promise<BunnyLiveStream> {
  const response = await bunnyRequest('POST', libraryId, apiKey, '/live', {
    title,
    dvrEnabled: options.dvrEnabled ?? true,
    recordVod: options.recordVod ?? false,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Bunny live create failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as BunnyLiveStream;
}

export async function bunnyGetLiveStream(
  libraryId: string,
  apiKey: string,
  streamId: string,
): Promise<BunnyLiveStream | null> {
  const response = await bunnyRequest('GET', libraryId, apiKey, `/live/${streamId}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Bunny live read failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as BunnyLiveStream;
}

/**
 * Delete the live stream.
 *
 * Only called for a session that recorded nothing: deleting a stream whose VOD
 * the platform still wants would take the recording with it.
 */
export async function bunnyDeleteLiveStream(
  libraryId: string,
  apiKey: string,
  streamId: string,
): Promise<void> {
  const response = await bunnyRequest('DELETE', libraryId, apiKey, `/live/${streamId}`);
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Bunny live delete failed (${response.status}): ${detail.slice(0, 300)}`);
  }
}

/**
 * The full RTMP destination: Bunny's ingest URL with the stream key as the
 * stream name. This string IS the credential — never log it, never return it
 * to a client. It exists to be handed to LiveKit's egress and nowhere else.
 */
export function bunnyRtmpDestination(stream: BunnyLiveStream): string {
  const base = stream.ingestEndpoints?.rtmp?.primaryIngestUrl;
  if (!base) {
    throw new Error('Bunny live stream has no RTMP ingest endpoint');
  }
  return `${base.replace(/\/+$/, '')}/${stream.streamKey}`;
}

/**
 * A CDN URL a viewer may use, signed when the pull zone has token
 * authentication switched on.
 *
 * The pull zone in front of library 740127 does NOT currently have it on —
 * there is no `bunny_stream_token_key` in the vault, and the VOD path
 * (content-get-playback-url) has always returned unsigned URLs. So this
 * returns the plain URL until that key appears, and starts signing the moment
 * it does, with no code change.
 *
 * The signature covers the DIRECTORY, not the one file: an HLS stream is a
 * manifest plus a segment request every few seconds, and a token bound to
 * `live.m3u8` alone would authorise the playlist and then 403 every segment.
 */
export async function signBunnyUrl(
  playbackUrl: string,
  tokenKey: string | null,
  expiresAt: number,
): Promise<string> {
  if (!tokenKey) return playbackUrl;

  const url = new URL(playbackUrl);
  // e.g. "/live/<guid>/" for "/live/<guid>/live.m3u8"
  const directory = url.pathname.replace(/[^/]*$/, '');

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${tokenKey}${directory}${expiresAt}`),
  );
  const token = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  url.searchParams.set('token', token);
  url.searchParams.set('expires', String(expiresAt));
  url.searchParams.set('token_path', directory);
  return url.toString();
}

// ---------------------------------------------------------------------------
// LiveKit server API
// ---------------------------------------------------------------------------

import { create as createJWT } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

/** The `video` grant of a LiveKit access token. Only the claims used here. */
export interface LiveKitGrant {
  room?: string;
  roomJoin?: boolean;
  roomRecord?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canUpdateOwnMetadata?: boolean;
}

export async function generateLiveKitToken(
  apiKey: string,
  apiSecret: string,
  identity: string,
  displayName: string,
  grant: LiveKitGrant,
  ttlSeconds = 3600,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  return await createJWT(
    { alg: 'HS256', typ: 'JWT' },
    { iss: apiKey, sub: identity, name: displayName, nbf: now, exp: now + ttlSeconds, video: grant },
    key,
  );
}

/** LiveKit's server APIs live on the https:// origin of the wss:// URL. */
export function livekitHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
}

/**
 * One Twirp call against a LiveKit service.
 *
 * Twirp is plain `POST /twirp/<package>.<Service>/<Method>` with a JSON body,
 * so it needs no SDK — which matters in Deno, where the Node-oriented
 * `livekit-server-sdk` is a much bigger ask than four lines of fetch.
 */
async function livekitTwirp<T>(
  wsUrl: string,
  token: string,
  service: string,
  method: string,
  body: unknown,
): Promise<T> {
  const response = await fetchWithTimeout(
    `${livekitHttpUrl(wsUrl)}/twirp/livekit.${service}/${method}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`LiveKit ${method} failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

/**
 * The encoding LiveKit composites at.
 *
 * Only two rungs, and both are above the creator's tier cap on purpose: Bunny
 * transcodes whatever it receives into its own adaptive ladder, so pushing a
 * clean 720p and letting the CDN make the 360p is better than pushing a soft
 * 360p that Bunny can only make softer. The tier cap still governs what the
 * creator's CAMERA captures — this is just the bridge in between.
 */
function egressPreset(quality: string): string {
  return quality === '1080p' ? 'H264_1080P_30' : 'H264_720P_30';
}

/**
 * LiveKit's EgressInfo, as it actually arrives.
 *
 * LiveKit's Twirp endpoints emit protobuf JSON in SNAKE_CASE — `ListEgress`
 * answers `{"items": [], "next_page_token": null}`, not `nextPageToken`. They
 * ACCEPT camelCase on the way in, which is what hid this: the request went
 * through, the egress really started, LiveKit answered 200, and reading
 * `.egressId` off the response gave `undefined`. The undefined was then written
 * to `live_sessions.livekit_egress_id`, PostgREST dropped the key, and the
 * column stayed NULL on every session — so live-end-session had no id to stop
 * the egress with. Three test broadcasts on 2026-09-01 left orphaned egresses
 * behind; LiveKit reaped them when the rooms emptied, which is luck, not
 * design, and would not hold for a room a creator leaves open.
 *
 * Both spellings are declared and read so this cannot silently regress if
 * LiveKit ever switches its JSON dialect.
 */
export interface EgressInfoResponse {
  egress_id?: string;
  egressId?: string;
  status?: string;
}

export interface EgressInfo {
  egressId: string;
  status?: string;
}

/** Never returns a partial: an egress we cannot name is one we cannot stop. */
function readEgressInfo(raw: EgressInfoResponse, method: string): EgressInfo {
  const egressId = raw.egress_id ?? raw.egressId;
  if (!egressId) {
    throw new Error(`LiveKit ${method} returned no egress id: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return { egressId, status: raw.status };
}

/**
 * Start pushing a LiveKit room to Bunny over RTMP.
 *
 * `single-speaker` rather than `grid`: the room has exactly one publisher by
 * design (viewers are on HLS now and never join), and the grid layout would
 * letterbox that one publisher inside a mostly empty canvas.
 *
 * SECURITY: `rtmpUrl` embeds the Bunny stream key. It is passed to LiveKit and
 * must never reach a log line or a response body.
 */
export async function startRoomCompositeEgress(
  wsUrl: string,
  apiKey: string,
  apiSecret: string,
  roomName: string,
  rtmpUrl: string,
  quality: string,
): Promise<EgressInfo> {
  const token = await generateLiveKitToken(
    apiKey,
    apiSecret,
    'egress-service',
    'egress',
    { roomRecord: true, room: roomName },
    3600,
  );

  // Sent in snake_case to match the dialect LiveKit answers in. It accepts
  // camelCase too, which is exactly why the response casing went unnoticed.
  const raw = await livekitTwirp<EgressInfoResponse>(
    wsUrl,
    token,
    'Egress',
    'StartRoomCompositeEgress',
    {
      room_name: roomName,
      layout: 'single-speaker',
      preset: egressPreset(quality),
      stream_outputs: [{ protocol: 'RTMP', urls: [rtmpUrl] }],
    },
  );

  return readEgressInfo(raw, 'StartRoomCompositeEgress');
}

/**
 * Stop the egress.
 *
 * Never throws: this is called while ending a session, and a session that
 * cannot be closed because LiveKit answered 404 to a stop for an egress that
 * had already stopped is a worse outcome than an orphaned egress — which
 * LiveKit reaps by itself when the room empties. Returns false so the caller
 * can log it.
 */
export async function stopEgress(
  wsUrl: string,
  apiKey: string,
  apiSecret: string,
  egressId: string,
): Promise<boolean> {
  try {
    const token = await generateLiveKitToken(
      apiKey,
      apiSecret,
      'egress-service',
      'egress',
      { roomRecord: true },
      600,
    );
    await livekitTwirp(wsUrl, token, 'Egress', 'StopEgress', { egress_id: egressId });
    return true;
  } catch (err) {
    console.error('[live] stopEgress failed', err);
    return false;
  }
}
