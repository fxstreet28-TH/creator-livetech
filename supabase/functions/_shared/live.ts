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

/** The quality rungs a session can be published at, lowest to highest. */
export type BroadcastQuality = '360p' | '480p' | '720p' | '1080p';

/**
 * The publish ceiling per rung, in Mbps.
 *
 * A HAND-WRITTEN COPY of publishBitrateFor in lib/live/constants.ts, and it has
 * to be: this file is a Deno edge function and cannot import from the Next app.
 * There is no build step that will catch the two drifting apart, so changing a
 * rung there means editing this table in the same commit. 720p was 3 until the
 * 2026-09-09 encoder-starvation fix doubled the ceiling; leaving it at 3 would
 * have understated HLS egress by exactly 2x for every session priced after it.
 */
export const PUBLISH_MBPS_BY_QUALITY: Record<BroadcastQuality, number> = {
  '360p': 1.6,
  '480p': 3,
  '720p': 6,
  '1080p': 9,
};

/**
 * THE ONE THING THIS TABLE CANNOT SEE: โหมดกราฟ.
 *
 * While a desktop creator is sharing a screen, the WHIP sender's ceiling is
 * raised by CHART_MODE_BITRATE_MULTIPLIER in lib/live/constants.ts — 1.5x, so
 * 720p publishes at 9 Mbps and 1080p at 13.5 while the share is up. A chart is
 * thin lines and small text corner to corner, and at the ladder's own rung an
 * H.264 encoder blocks exactly those; the multiplier is what buys them back.
 *
 * IT IS NOT ADDED TO THE TABLE, and that is deliberate rather than an
 * oversight. A share is started and stopped mid-broadcast, several times in a
 * session, and nothing records how many of a session's minutes carried one —
 * so there is no honest per-session number to put here. What the row can say
 * is a RANGE, and this is that statement:
 *
 *   the figures above are the LOWER bound for a session that shared a screen;
 *   the upper bound is 1.5x them, reached only for the minutes a share was up.
 *
 * A session that never shared is priced exactly, as it always was. A session
 * that shared throughout is under-charged by at most 1.5x on the Bunny line —
 * which at 0.0077 THB/viewer-minute at 720p is 0.0039 THB/viewer-minute of
 * under-estimate, against a budget kill switch measured in thousands of baht.
 * Recording share-minutes on the session row is the fix if that ever matters;
 * it is a schema change and not this PR's business.
 */
export const CHART_MODE_MBPS_MULTIPLIER = 1.5;

/**
 * Bunny CDN, per viewer-minute, AT THE RUNG THE SESSION WAS PUBLISHED AT.
 *
 * 720p at 6 Mbps is 45 MB/minute; APAC volume tier is $0.005/GB. That works
 * out at ~0.0077 THB, against the 0.0377 THB/viewer-minute the pre-migration
 * model charged — so the migration's saving is ~5x rather than the ~10x it was
 * at 3 Mbps, and still the reason the migration happened.
 *
 * PER-RUNG RATHER THAN A SINGLE CONSTANT, as of the 1080p rung being offered
 * to creators. It was one number while every session was 720p in practice; a
 * creator-selectable rung makes that number wrong in both directions at once —
 * it would under-charge a 1080p chart session by 1.5x and over-charge a 360p
 * phone broadcast by nearly 4x, and the total feeds the platform budget that
 * `check_creator_can_golive` refuses go-lives on. A bill that is wrong in the
 * cheap direction walks the platform toward its own kill switch for free.
 *
 * WHAT THIS LINE IS AND IS NOT. It prices bytes Bunny serves, which means
 * HLS-delivered viewers. A viewer on the WHEP path is served by the origin
 * droplet and touches Bunny not at all — yet estimateLiveCost below charges
 * this line for every delivery mode including 'origin'. That over-charge is
 * older than this change and is deliberate on the safe side (see the note on
 * estimateLiveCost); raising a rung raises it too. Worth revisiting now that
 * WHEP is the primary origin path; not changed here, because quietly making
 * the kill switch more permissive is not a resolution PR's business.
 */
export function bunnyThbPerViewerMinute(quality: BroadcastQuality = '720p'): number {
  const mbps = PUBLISH_MBPS_BY_QUALITY[quality] ?? PUBLISH_MBPS_BY_QUALITY['720p'];
  return ((mbps * 60) / 8 / 1024) * 0.005 * THB_PER_USD;
}

/** The 720p rate, which is what a caller naming no rung is priced at. */
export const BUNNY_LIVE_THB_PER_VIEWER_MINUTE = bunnyThbPerViewerMinute('720p');

export interface LiveCostBreakdown {
  livekitThb: number;
  bunnyThb: number;
  totalThb: number;
}

/** Which pipeline carried the session being priced. */
export type LiveDeliveryMode = 'livekit' | 'llhls' | 'origin' | 'livekit_selfhost';

/** Every valid mode, so a value read back off a row can be rejected. */
export const LIVE_DELIVERY_MODES: readonly LiveDeliveryMode[] = [
  'livekit',
  'llhls',
  'origin',
  'livekit_selfhost',
];

/**
 * The delivery mode a session RECORDED for itself, or null if it did not.
 *
 * `live_delivery_mode` in the vault answers a different question — what the
 * next session will get — so anything asking "what was THIS session on" has to
 * read the row. live-create-session writes it into `metadata.delivery_mode` at
 * insert; see the note there for why no other column can stand in for it.
 *
 * Null rather than a default, because the two callers want DIFFERENT fallbacks
 * and neither is safe to bake in here: pricing has to reproduce the old
 * derivation exactly so historical rows do not reprice themselves, while
 * token-minting wants the vault's current mode. A default here would silently
 * give one of them the other's answer.
 */
export function storedDeliveryMode(metadata: unknown): LiveDeliveryMode | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).delivery_mode;
  if (typeof value !== 'string') return null;
  return (LIVE_DELIVERY_MODES as readonly string[]).includes(value)
    ? (value as LiveDeliveryMode)
    : null;
}

/**
 * Which LiveKit deployment's credentials a mode calls for.
 *
 * THE ONLY DIFFERENCE between 'livekit' and 'livekit_selfhost' anywhere in the
 * stack. Both mint the same token for the same room name and the same player
 * joins it — but a LiveKit token is an HMAC over the API secret, so signing
 * with Cloud's secret and connecting to livekit-sg-1 yields a token the server
 * refuses. That is not hypothetical: live-get-playback-url did exactly this on
 * 2026-09-10, and the symptom was a viewer stuck on "กำลังรอสัญญาณจาก
 * Creator" indefinitely, because a refused join is indistinguishable from a
 * room nobody has published into yet.
 *
 * The names to request and the way to read them back are one PAIR of functions
 * on purpose — they are the two halves of a single fact, and splitting them
 * across two files is how they would drift.
 */
export function livekitVaultNamesFor(deliveryMode: string): string[] {
  return deliveryMode === 'livekit_selfhost'
    ? ['livekit_selfhost_ws_url', 'livekit_selfhost_api_key', 'livekit_selfhost_api_secret']
    : ['livekit_ws_url', 'livekit_api_key', 'livekit_api_secret'];
}

export interface LiveKitCreds {
  wsUrl: string;
  apiKey: string;
  apiSecret: string;
}

export function resolveLiveKitCreds(
  deliveryMode: string,
  secrets: Record<string, string>,
): LiveKitCreds {
  if (deliveryMode === 'livekit_selfhost') {
    return {
      wsUrl: secrets.livekit_selfhost_ws_url,
      apiKey: secrets.livekit_selfhost_api_key,
      apiSecret: secrets.livekit_selfhost_api_secret,
    };
  }
  return {
    wsUrl: secrets.livekit_ws_url,
    apiKey: secrets.livekit_api_key,
    apiSecret: secrets.livekit_api_secret,
  };
}

/**
 * What one finished session cost.
 *
 * Peak viewers rather than an average: it is the only audience number the
 * platform actually records (see persistViewerCounts on the client), and
 * over-estimating the bill is the safe direction for a budget kill switch.
 *
 * DELIVERY CHANGES THE PER-STREAM LINE, and getting this wrong is not just a
 * cosmetic figure on a creator's summary. `estimated_cost_thb` is posted to the
 * platform budget, and the budget is what `check_creator_can_golive` refuses
 * go-lives on — so a session charged for infrastructure it never touched walks
 * the platform toward its own kill switch for free.
 *
 * An 'origin' session touches neither LiveKit nor Bunny Live: the creator's
 * WHIP stream terminates on origin-sg-1, which is a droplet on a FLAT monthly
 * bill. A flat cost does not belong in a per-session estimate at all — it is
 * the same amount whether the box carries zero broadcasts or twelve — so the
 * per-stream line is zero rather than small. The audience line stays exactly as
 * it is: those bytes are still Bunny CDN egress at the same bitrate, so the
 * same per-viewer-minute rate applies whichever origin served them.
 *
 * A 'livekit_selfhost' session is the only mode where BOTH lines are zero, and
 * it is worth being explicit about why, because "the bill is zero" is the kind
 * of claim that should not pass without an argument.
 *
 *   - The per-stream line is zero for the same reason 'origin' is: livekit-sg-1
 *     is a $28.80/month droplet, and a flat cost is not a per-session one.
 *   - The audience line is zero because there is NO CDN IN THE PATH. Viewers
 *     subscribe to the self-hosted SFU over WebRTC and are served by that
 *     droplet directly; Bunny is not involved, so charging Bunny's
 *     per-viewer-minute rate would be inventing a bill for a vendor this
 *     session never used. That is not the safe direction — `estimated_cost_thb`
 *     feeds `platform_budget_state`, and a phantom charge walks the platform
 *     toward its own kill switch.
 *
 * WHAT ZERO IS HIDING, recorded here so it is not rediscovered the hard way:
 * the droplet's bandwidth ALLOWANCE is finite (4 TB/month on this tier, then
 * $0.01/GB). At the 6 Mbps 720p rung that is roughly 1.5 million viewer-minutes
 * before a single baht of overage, which is far beyond anything this platform
 * has served — so zero is honest today and is NOT honest at scale. The trigger
 * to revisit is the droplet's transfer graph, not this function.
 */
export function estimateLiveCost(
  durationMinutes: number,
  peakViewers: number,
  delivery: LiveDeliveryMode = 'llhls',
  /**
   * The rung the session published at, from its own row.
   *
   * Defaulted to 720p, which is both the form's default and what every session
   * priced before the 1080p rung existed was actually published at — so an old
   * row with no quality recorded prices exactly as it did before.
   */
  quality: BroadcastQuality = '720p',
): LiveCostBreakdown {
  const selfHosted = delivery === 'origin' || delivery === 'livekit_selfhost';
  const livekitThb = selfHosted ? 0 : durationMinutes * LIVEKIT_THB_PER_STREAM_MINUTE;
  // 'origin' still pays this line — its viewers are served through a Bunny pull
  // zone. 'livekit_selfhost' does not: its viewers are on WebRTC to our own SFU
  // and never touch a CDN. See the note above.
  const bunnyThb =
    delivery === 'livekit_selfhost'
      ? 0
      : durationMinutes * peakViewers * bunnyThbPerViewerMinute(quality);
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
 * A LIVE STREAM IS NOT A VIDEO. It is created at `POST /library/{id}/live`,
 * not `/videos`, and it is the only call that returns a `streamKey` and
 * `ingestEndpoints` — the two things an RTMP push needs. `/videos` creates a
 * VOD upload target with neither. The two resources do share an id space: a
 * live stream's guid also resolves at `/videos/{guid}`, which makes it easy to
 * conclude from a 404 there that an id is fabricated when it is simply a
 * stream that has since been deleted — live-end-session deletes every stream
 * that recorded nothing, so an ended session's id 404s on BOTH routes.
 *
 * Bunny's own id and key formats, for anyone checking: guids come back as
 * UUIDv7 (`01a05de6-e9fa-73fd-…`, so they sort by creation time) and stream
 * keys as `bunnylive_<32 hex>`. Both are Bunny's, not ours; nothing in this
 * codebase generates either.
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
 *
 * Both halves come from Bunny's own create response — `ingestEndpoints.rtmp
 * .primaryIngestUrl` and `streamKey`. Neither is constructed here, and neither
 * should be: the ingest host is account- and region-dependent, so a hardcoded
 * one would work until it silently did not.
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
