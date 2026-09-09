'use client';

/**
 * WHEP subscriber — the viewer's half of `delivery_mode = 'origin'`.
 *
 * WHAT THIS IS FOR. The origin path already delivers: MediaMTX remuxes the
 * creator's WHIP stream into LL-HLS, Bunny fronts it, and HlsLivePlayer plays
 * it for a hundredth of what LiveKit cost. What it does not do is arrive
 * quickly. Five to seven seconds behind the live edge is the SUM of a
 * one-second segment, the CDN's cache window and the viewer's own buffer, and
 * none of those three are tuning knobs — PR #59 turned every one of them as far
 * as it goes and the floor did not move. It is a property of shipping video as
 * a sequence of files.
 *
 * WHEP is the same server answering the same question over WebRTC instead.
 * MediaMTX speaks it on the port it already speaks WHIP on, Caddy routes
 * `/whep/live/<room>` to it exactly as it routes `/whip/live/<room>`, and the
 * stream reaches the viewer as RTP with no segment, no playlist and no CDN in
 * between. That is 200-500ms, which is LiveKit's number, on origin infra.
 *
 * WHEP, in full (RFC 9725's egress half), is smaller than WHIP:
 *
 *   POST  <endpoint>              Content-Type: application/sdp, body = offer
 *     201 Created                 Location: <resource>, body = answer
 *   DELETE <resource>             tear the session down
 *
 * NO ICE RESTART, NO RECONNECT LADDER — the two things whipClient.ts spends
 * most of its length on. A publisher that drops has a camera, an encoder and a
 * MediaMTX path worth saving, and a re-POST would restart the HLS muxer under
 * every viewer mid-segment. A subscriber has none of that: it holds nothing the
 * server needs and nothing another viewer can see. So a failed WHEP session is
 * never repaired — it is DISCARDED and, where it is worth having again, a whole
 * new one is negotiated from scratch. That is one POST and under a second, and
 * it is the entire recovery story on this path: WhepLivePlayer resubscribes,
 * and OriginLivePlayer moves the viewer to the HLS URL on the same session row
 * once the resubscribes have been spent. See isStructuralWhepFailure for which
 * failures are worth another handshake and which are a verdict about WHEP.
 *
 * NOT A CAPABILITY, unlike the WHIP endpoint. `whip_publish_url` is the publish
 * grant — whoever reaches the path first broadcasts into it — which is why it
 * carries eight characters of crypto-random and never leaves the creator's own
 * response. A WHEP endpoint is read-only: MediaMTX will only ever send the
 * stream down it. It is derived here from the room id inside the HLS playback
 * URL, which every entitled viewer has already been handed, so this adds
 * nothing to what a viewer knows. See whepEndpointFromHlsPlaybackUrl.
 */

/**
 * Where a WHEP endpoint is built from, minus the room.
 *
 * A PUBLIC ENV VAR RATHER THAN A FIELD ON THE SESSION ROW, and that is the
 * whole reason this function exists instead of a `.replace('/whip/','/whep/')`
 * on `whip_publish_url`: a viewer never receives `whip_publish_url`. It is not
 * in SESSION_COLUMNS, live-get-playback-url does not select it, and it must not
 * be either — see the module header. What the viewer does have is the origin
 * room id, sitting in plain sight in the middle of the HLS playback URL.
 *
 * Defaulted rather than required, following NEXT_PUBLIC_BUNNY_STREAM_CDN_HOSTNAME
 * in lib/viewer/publicFeed.ts. A wrong or missing value cannot break playback:
 * the handshake fails against it and the viewer lands on HLS, which is where
 * they would have been anyway.
 */
const WHEP_ENDPOINT_BASE =
  process.env.NEXT_PUBLIC_LIVE_WHEP_BASE || 'https://origin.creatorlivetech.com/whep/live/';

/**
 * How long to wait for ICE candidate gathering before posting the offer anyway.
 *
 * Shorter than the publisher's three seconds (whipClient.ts) on purpose. Both
 * are non-trickle and both are waiting for the same host and server-reflexive
 * candidates, but the costs of waiting differ: a creator waiting three seconds
 * is waiting to go live, once, and a stall is worse than a delay; a viewer
 * waiting three seconds is three seconds of black screen before a fallback that
 * itself needs a few seconds to buffer. Two seconds is past the point where the
 * candidates that carry the stream have arrived — origin-sg-1 answers on a
 * public address, so the stragglers are relay candidates this path never uses.
 */
const ICE_GATHERING_TIMEOUT_MS = 2_000;

/** How long the POST may take before the attempt is abandoned for HLS. */
const WHEP_REQUEST_TIMEOUT_MS = 10_000;

/** How long the teardown DELETE may take. Short: nothing waits on the answer. */
const WHEP_DELETE_TIMEOUT_MS = 5_000;

export interface WhepSubscribeOptions {
  /** The WHEP endpoint, from whepEndpointFromHlsPlaybackUrl. */
  endpoint: string;
  /**
   * Called once, as soon as the first remote track arrives.
   *
   * The MediaStream handed over is OURS and its identity is stable: later
   * tracks are added to the same object, which a <video> already playing it
   * picks up without being re-attached. A stream per track would mean
   * reassigning srcObject mid-playback, which restarts the element.
   */
  onStream: (stream: MediaStream) => void;
  /** Aborts a handshake in flight when the component unmounts mid-negotiation. */
  signal?: AbortSignal;
}

export interface WhepSession {
  /** The live peer connection, so callers can watch `connectionstatechange`. */
  readonly pc: RTCPeerConnection;
  /** The WHEP resource, from the 201's `Location`. Null when none was sent. */
  readonly resourceUrl: string | null;
  /**
   * DELETE the resource and close the peer connection. Never throws, never
   * blocks: the DELETE is fired and forgotten so an unmount is not held up by
   * a request whose answer nobody reads.
   */
  close(): void;
}

/**
 * Negotiate a WHEP session and start receiving.
 *
 * Throws on any failure to reach the receiving state. The caller's answer to a
 * throw is HLS, not a retry — see the module header and PR #52's ladder, which
 * owns recovery from that point on.
 */
export async function subscribeWhep(options: WhepSubscribeOptions): Promise<WhepSession> {
  console.info('[whep] handshake start', { endpoint: options.endpoint });

  /**
   * A browser with no WebRTC at all.
   *
   * STRUCTURAL, and named as such — see isStructuralWhepFailure. Every other
   * failure in this file is worth another go on the viewer's next resume,
   * because the usual cause of one is that iOS suspended the tab. This cause
   * does not change while the page is open, so retrying it is a guaranteed
   * black second bought on every fold of the phone.
   */
  if (typeof RTCPeerConnection === 'undefined') {
    throw new WhepError('no_webrtc', 'This browser has no RTCPeerConnection');
  }

  /**
   * No ICE servers, deliberately — the same call whipClient.ts makes, for the
   * same reason. origin-sg-1 advertises a public address directly
   * (`webrtcICEHostNAT1To1IPs`), so a STUN round trip would be a third-party
   * hop on the critical path of every viewer join, to discover an address only
   * needed when BOTH ends are behind NAT.
   */
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });

  try {
    /**
     * One stream for the life of the session, filled as tracks arrive.
     *
     * MediaMTX sends video and audio as two tracks, and `event.streams[0]` is
     * not guaranteed to be the same object for both. Assigning whichever one
     * arrived to `srcObject` twice restarts the element; owning the container
     * here means the second track simply appears in a stream that is already
     * playing.
     */
    const remoteStream = new MediaStream();
    let announced = false;

    pc.ontrack = (event) => {
      remoteStream.addTrack(event.track);
      console.info('[whep] track received', { kind: event.track.kind });
      if (announced) return;
      announced = true;
      options.onStream(remoteStream);
    };

    /**
     * Receive-only transceivers, video first.
     *
     * They have to be added BEFORE the offer: an offer with no m-lines asks the
     * server for nothing, and MediaMTX answers it with nothing — a 201 and a
     * silent black player, which is the failure that does not look like one.
     */
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.info('[whep] local offer set');

    await waitForIceGathering(pc, options.signal);
    throwIfAborted(options.signal);
    console.info('[whep] ICE gathering settled', { state: pc.iceGatheringState });

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw new WhepError('no_local_sdp', 'Local description was never set');

    const { answerSdp, resourceUrl } = await postOffer(options.endpoint, localSdp, options.signal);
    console.info('[whep] answer received', { resourceUrl });

    throwIfAborted(options.signal);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    console.info('[whep] remote description set; waiting for media');

    return {
      pc,
      resourceUrl,
      close: () => closeWhepSession(pc, resourceUrl),
    };
  } catch (err) {
    // The peer connection is this function's to own until it hands one back.
    // Left open on a failed handshake it would sit there holding a decoder
    // while the HLS player it fell back to builds its own.
    pc.close();
    console.warn('[whep] handshake failed', err);
    throw err;
  }
}

/**
 * POST the offer and read the answer.
 *
 * `201 Created` is what the spec requires; `200 OK` is accepted too, because it
 * is what several WHEP servers actually send and refusing a working answer over
 * a status code would cost a viewer the low-latency path for nothing.
 *
 * The response body is carried into the error on a refusal. It is the only
 * thing that distinguishes "no publisher on this path yet" from "MediaMTX is
 * unwell", and after the fallback fires there is nothing else left to look at.
 */
async function postOffer(
  endpoint: string,
  sdp: string,
  signal: AbortSignal | undefined,
): Promise<{ answerSdp: string; resourceUrl: string | null }> {
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
      body: sdp,
      signal,
    },
    WHEP_REQUEST_TIMEOUT_MS,
  );

  if (response.status !== 201 && response.status !== 200) {
    const body = await response.text().catch(() => '');
    /**
     * 404 is the common one and it is NOT a fault.
     *
     * MediaMTX has no path until the creator's publisher connects, so every
     * viewer who opens the page a few seconds early gets one. The fallback
     * handles it correctly by itself — HlsLivePlayer's 'manifest_missing' wait
     * is the screen that state deserves — so it is named here only so the
     * console says "nobody is publishing" rather than "something broke".
     */
    const code = response.status === 404 ? 'no_publisher' : `http_${response.status}`;
    throw new WhepError(
      code,
      `WHEP endpoint refused the offer (HTTP ${response.status})${body ? `: ${body.slice(0, 300)}` : ''}`,
    );
  }

  const answerSdp = await response.text();
  if (!answerSdp.trim()) throw new WhepError('empty_answer', 'WHEP endpoint returned an empty answer');

  /**
   * The `Location` header is a URI REFERENCE, not necessarily an absolute URL —
   * MediaMTX sends a root-relative `/live/<room>/whep/<session>` — so it is
   * resolved against the endpoint here, while there is still a session to
   * report a malformed one against. Same handling as whipClient.ts.
   */
  const location = response.headers.get('Location');
  let resourceUrl: string | null = null;
  if (location) {
    try {
      resourceUrl = new URL(location, endpoint).toString();
    } catch {
      console.warn('[whep] unparseable Location header; session cannot be DELETEd');
    }
  } else {
    // Legal, and it costs only the polite teardown: MediaMTX drops the reader
    // when the peer connection dies either way.
    console.warn('[whep] no Location header; teardown will rely on the connection closing');
  }

  return { answerSdp, resourceUrl };
}

/**
 * Tear the session down: tell the server, then close locally.
 *
 * FIRE AND FORGET ON THE DELETE, IMMEDIATE ON THE CLOSE. Awaiting the request
 * would put a network round trip inside a React cleanup — which runs on every
 * unmount, including a navigation the browser is already tearing the page down
 * for. `keepalive` is what lets the request outlive the page; `pc.close()` on
 * the next line is what actually ends the subscription, since MediaMTX drops a
 * reader whose peer connection goes away.
 */
function closeWhepSession(pc: RTCPeerConnection, resourceUrl: string | null): void {
  if (resourceUrl) {
    void fetchWithTimeout(resourceUrl, { method: 'DELETE', keepalive: true }, WHEP_DELETE_TIMEOUT_MS)
      .then(() => console.info('[whep] session deleted'))
      .catch((err) => console.warn('[whep] DELETE failed; closed locally anyway', err));
  }
  pc.close();
  console.info('[whep] peer connection closed');
}

/**
 * The WHEP endpoint for a session, from the HLS playback URL it was handed.
 *
 * WHY NOT `whip_publish_url.replace('/whip/', '/whep/')`. That is the natural
 * derivation and it is unavailable on this side of the wire: the publish URL is
 * the creator's alone (see the module header), and adding it to the viewer's
 * payload to save a string operation would hand every viewer of every broadcast
 * the ability to publish into it.
 *
 * The room id is the one part of the two URLs that IS shared, and the playback
 * URL carries it in the clear:
 *
 *   https://aurum-live-origin.b-cdn.net/hls/live/<room>/index.m3u8
 *   https://origin.creatorlivetech.com/whep/live/<room>
 *
 * Returns null for anything that is not shaped like an origin playlist —
 * a Bunny Live URL from the llhls pipeline, a signed URL with the room in a
 * query string, an unparseable string. Null is not an error: the caller renders
 * the HLS player directly, which is what it would have rendered anyway.
 *
 * Exported for tests, and because it is the one piece of this file that can be
 * checked without a peer connection and a server.
 */
export function whepEndpointFromHlsPlaybackUrl(playbackUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(playbackUrl);
  } catch {
    return null;
  }

  // Last-but-one segment: the playlist filename is last, the room id precedes
  // it. Read from the end rather than by index, so a base path with more or
  // fewer prefix segments than `/hls/live/` does not silently pick a room id
  // out of the wrong place.
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const room = segments[segments.length - 2];

  // The same character class Caddy's WHIP route matches on. A room id is
  // `<session uuid>-<8 random chars>` (see randomPathSuffix in
  // live-create-session), so anything outside this set is not one of ours.
  if (!/^[A-Za-z0-9_-]+$/.test(room)) return null;

  const base = WHEP_ENDPOINT_BASE.endsWith('/') ? WHEP_ENDPOINT_BASE : `${WHEP_ENDPOINT_BASE}/`;
  return `${base}${room}`;
}

/**
 * Resolve once ICE has gathered everything, or once the timeout says enough.
 *
 * See ICE_GATHERING_TIMEOUT_MS. `complete` is not reliably reached — Safari can
 * sit at `gathering` indefinitely when a candidate type times out rather than
 * failing — and a viewer waiting for a terminal state that never arrives is a
 * black screen that never falls back either.
 */
function waitForIceGathering(
  pc: RTCPeerConnection,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      signal?.removeEventListener('abort', finish);
      resolve();
    };

    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onStateChange);
    // Abort resolves rather than rejects: the caller checks the signal on the
    // next line, which keeps one abort path instead of two.
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * `fetch` with a deadline, honouring a caller's own abort signal too.
 *
 * AbortSignal.any() would say this in one line and is not used, for the same
 * reason whipClient.ts does not use it: it is unsupported on the iOS Safari
 * versions this product still targets, and this is a viewer path where most of
 * the audience is on exactly those.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const callerSignal = init.signal ?? undefined;
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WhepError('aborted', 'WHEP subscribe was aborted');
}

/**
 * A failure with a machine-readable code.
 *
 * Nothing renders these — every one of them ends in the same place, which is
 * the HLS player — so unlike WhipError there is no thaiFor… beside it. The code
 * is for the console line that tells Por which rung of the handshake gave way.
 */
export class WhepError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WhepError';
    this.code = code;
  }
}

/**
 * Failure codes that mean WHEP CANNOT work here, as opposed to did not just now.
 *
 * THIS IS THE LINE PR #60 GOT WRONG, and it is the whole of why a folded phone
 * never came back. That PR's rule was "one WHEP failure falls back to HLS
 * permanently for this mount", and for the failures it was written against —
 * a corporate firewall eating UDP, a browser with WebRTC switched off — it is
 * exactly right: a handshake that failed for one of those reasons fails again
 * for the same reason, and every retry is another black second charged to the
 * viewer's patience.
 *
 * A peer connection that iOS closed while the tab was in the background is not
 * one of those. It is not evidence about WHEP at all; it is evidence that the
 * tab was suspended. Treating it as a capability verdict threw away the
 * low-latency path for the rest of an hour-long broadcast over an ordinary
 * phone gesture — and, because the HLS fallback is suspended too, it did not
 * even buy a picture.
 *
 * So the permanent rule survives, narrowed to the codes that actually mean it:
 *
 *   no_webrtc   the browser has no RTCPeerConnection
 *   no_publisher (HTTP 404) no such path — the creator is not pushing frames,
 *                and HlsLivePlayer's counted waiting screen is the correct
 *                place for a viewer who arrived early, not a spinner that
 *                falls back eight seconds later
 *   http_405    the endpoint does not take POST
 *   http_501    the server does not implement WHEP
 *   no_local_sdp the browser would not build an offer
 *
 * Everything else — a failed or closed connection, a network error, a timeout,
 * a 5xx — is retryable, and a resume tries WHEP again. See OriginLivePlayer for
 * the bounded ladder that spends those retries.
 */
const STRUCTURAL_WHEP_FAILURES = new Set([
  'no_webrtc',
  'no_publisher',
  'http_405',
  'http_501',
  'no_local_sdp',
]);

/**
 * Whether a failure reason should retire WHEP for the whole broadcast.
 *
 * Takes the string reason the player reports rather than the error, because by
 * the time the router decides this it is holding a code from `WhepError.code`,
 * a peer-connection state, or one of the player's own verdicts.
 */
export function isStructuralWhepFailure(reason: string): boolean {
  return STRUCTURAL_WHEP_FAILURES.has(reason);
}
