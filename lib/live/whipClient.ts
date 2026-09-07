'use client';

/**
 * WHIP publisher — the creator's half of `delivery_mode = 'origin'`.
 *
 * WHAT THIS REPLACES. On the LiveKit and llhls paths the creator's browser
 * hands its stream to `livekit-client`, which owns the peer connection, the
 * signalling socket, the reconnects and the encoding parameters. On the origin
 * path there is no SDK and no room: the browser negotiates ONE peer connection
 * directly with MediaMTX on origin-sg-1 over WHIP, which is a single HTTP POST
 * carrying an SDP offer.
 *
 * WHIP, in full (RFC 9725), is that small:
 *
 *   POST  <endpoint>              Content-Type: application/sdp, body = offer
 *     201 Created                 Location: <resource>, body = answer
 *   DELETE <resource>             tear the session down
 *
 * ROLLED BY HAND RATHER THAN TAKING A DEPENDENCY. The whole protocol is the
 * ~60 lines below; the npm clients wrap the same three calls and bring their
 * own reconnect opinions, which would then be a second reconnect policy
 * fighting the one CreatorBroadcaster already runs for the LiveKit path.
 *
 * WHAT IS PUBLISHED IS THE CANVAS, NOT THE CAMERA — same as the LiveKit
 * publisher, and for the same reason. The stream handed in here is the output
 * of createFilteredStream, so the creator's chosen look reaches viewers instead
 * of stopping at their own preview, and the iOS framing fix (PR #50: facingMode
 * only, no width/height/aspectRatio hints) applies unchanged because the camera
 * upstream of the canvas is opened by the same openCamera call either way.
 *
 * SECURITY: the endpoint URL IS the publish capability. MediaMTX decides who
 * may publish to a path purely by who reaches it first, so `whip_publish_url`
 * is minted per session with eight characters of crypto-random on the end and
 * is only ever returned to the authenticated creator who opened the session.
 * It must not be logged, put in a query string, or persisted — same contract as
 * a LiveKit publisher token. See randomPathSuffix in live-create-session.
 */

import type { BroadcastQuality } from './types';
import { publishBitrateFor } from './constants';

/**
 * How long to wait for ICE candidate gathering before posting the offer anyway.
 *
 * This publisher is NON-TRICKLE: it posts one complete offer rather than
 * PATCHing candidates in as they arrive, because that is the half of WHIP
 * MediaMTX implements and it keeps the whole exchange to a single round trip.
 *
 * The timeout exists because "gathering complete" is not reliably reached.
 * Safari in particular can leave the state at `gathering` indefinitely when a
 * candidate type times out rather than fails, and a publisher that waits for a
 * terminal state it will never see is a go-live that hangs forever with the
 * camera on. Three seconds is far past the point where the host and
 * server-reflexive candidates that actually carry the stream have arrived — the
 * stragglers are relay candidates this path does not use, since origin-sg-1
 * answers on a public address.
 */
const ICE_GATHERING_TIMEOUT_MS = 3_000;

/** How long the POST may take before the attempt is abandoned. */
const WHIP_REQUEST_TIMEOUT_MS = 15_000;

/** How long the teardown DELETE may take. Short: nothing waits on the answer. */
const WHIP_DELETE_TIMEOUT_MS = 5_000;

export interface WhipPublishOptions {
  /**
   * The WHIP ingest endpoint, from `whip_publish_url` on the session row.
   * SECURITY: a publish capability. See the module header.
   */
  endpoint: string;
  /** The canvas-composited stream from createFilteredStream. */
  stream: MediaStream;
  /** Decides the encoder ceiling. See publishBitrateFor. */
  quality: BroadcastQuality;
  /** Start with the mic muted — the toggle on the setup screen. */
  micEnabled?: boolean;
  /** Frames per second the encoder is capped at. Matches resolutionFor(). */
  maxFramerate?: number;
  /** Aborts a publish in flight when the component unmounts mid-negotiation. */
  signal?: AbortSignal;
}

export interface WhipSession {
  /** The live peer connection, so callers can watch `connectionstatechange`. */
  readonly pc: RTCPeerConnection;
  /**
   * The WHIP resource this session is addressable at, from the 201's `Location`.
   * Null when the server answered 201 without one — legal, and it only costs
   * the polite teardown below.
   */
  readonly resourceUrl: string | null;
  /** DELETE the resource and close the peer connection. Never throws. */
  close(): Promise<void>;
}

/**
 * Negotiate a WHIP session and start publishing.
 *
 * Throws on any failure to reach the publishing state; the caller is expected
 * to surface `thaiForWhipError` and offer a retry, exactly as it does for
 * `thaiForConnectError` on the LiveKit path.
 */
export async function publishWhip(options: WhipPublishOptions): Promise<WhipSession> {
  const [videoTrack] = options.stream.getVideoTracks();
  const [audioTrack] = options.stream.getAudioTracks();

  if (!videoTrack) throw new WhipError('no_video_track', 'Stream has no video track to publish');

  /**
   * No ICE servers, deliberately.
   *
   * origin-sg-1 answers on a public address that MediaMTX advertises directly
   * (`webrtcICEHostNAT1To1IPs`), so the browser has a reachable host candidate
   * without asking a STUN server where it is. Adding one would be a third-party
   * round trip on the critical path of every go-live, to discover an address
   * only needed when BOTH ends are behind NAT — which cannot be the case here.
   */
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });

  try {
    /**
     * Audio transceiver FIRST, and added even when the mic starts muted.
     *
     * The m-line order is fixed at negotiation and cannot change without
     * renegotiating, so a session that started muted and skipped the audio
     * transceiver could never unmute — the toggle would silently do nothing for
     * the rest of the broadcast. Muting is done on the track instead, which is
     * what the mic button already toggles on the LiveKit path.
     */
    if (audioTrack) {
      audioTrack.enabled = options.micEnabled !== false;
      pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [options.stream] });
    }

    const videoTransceiver = pc.addTransceiver(videoTrack, {
      direction: 'sendonly',
      streams: [options.stream],
      sendEncodings: [
        {
          maxBitrate: publishBitrateFor(options.quality),
          ...(options.maxFramerate ? { maxFramerate: options.maxFramerate } : {}),
        },
      ],
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    /**
     * Re-apply the encoder ceiling after setLocalDescription.
     *
     * `sendEncodings` above is ignored by some browsers (Safari has shipped
     * several versions that accept it and apply nothing), and an uncapped
     * encoder does not fail — it succeeds at 8 Mbps, which saturates a phone's
     * uplink and bills as if the cost model said something it does not. This is
     * the belt to that braces: setParameters after negotiation is the path
     * every browser honours.
     */
    await applyEncoderCeiling(videoTransceiver.sender, options);

    await waitForIceGathering(pc, options.signal);
    throwIfAborted(options.signal);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw new WhipError('no_local_sdp', 'Local description was never set');

    const { answerSdp, resourceUrl } = await postOffer(options.endpoint, localSdp, options.signal);

    throwIfAborted(options.signal);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    return {
      pc,
      resourceUrl,
      close: () => closeWhipSession(pc, resourceUrl),
    };
  } catch (err) {
    // The peer connection is this function's to own until it hands one back.
    // Leaving it open on a failed negotiation holds the encoder and, on a
    // retry, leaves the previous attempt's connection racing the new one.
    pc.close();
    throw err;
  }
}

/**
 * POST the offer and read the answer.
 *
 * `201 Created` is what the spec requires. `200 OK` is accepted too because it
 * is what several WHIP servers actually send and refusing a working answer over
 * a status code would fail a broadcast for nothing.
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
      headers: { 'Content-Type': 'application/sdp' },
      body: sdp,
      signal,
    },
    WHIP_REQUEST_TIMEOUT_MS,
  );

  if (response.status !== 201 && response.status !== 200) {
    /**
     * 409 is the one worth naming.
     *
     * MediaMTX answers it when the path already has a publisher — which on this
     * platform means a previous session that has not been reaped yet, most
     * often the creator's own reconnect racing their old connection. It is not
     * the same problem as "the origin is down", and telling a creator to check
     * their internet when the fix is to wait ten seconds sends them the wrong
     * way.
     */
    const code = response.status === 409 ? 'path_taken' : `http_${response.status}`;
    throw new WhipError(code, `WHIP ingest refused the offer (HTTP ${response.status})`);
  }

  const answerSdp = await response.text();
  if (!answerSdp.trim()) throw new WhipError('empty_answer', 'WHIP ingest returned an empty answer');

  /**
   * The `Location` header is a URI REFERENCE, not necessarily an absolute URL —
   * MediaMTX sends a root-relative path — so it is resolved against the
   * endpoint before being kept. Resolving it here rather than at teardown means
   * a malformed one is noticed while there is still a session to report it on.
   */
  const location = response.headers.get('Location');
  let resourceUrl: string | null = null;
  if (location) {
    try {
      resourceUrl = new URL(location, endpoint).toString();
    } catch {
      console.warn('[whipClient] unparseable Location header; session cannot be DELETEd');
    }
  }

  return { answerSdp, resourceUrl };
}

/**
 * Tear the session down: tell the server, then close locally.
 *
 * BEST-EFFORT ON THE DELETE, DECISIVE ON THE CLOSE. If the DELETE fails the
 * connection is closed anyway — MediaMTX drops the path when the peer
 * connection dies, so the worst case is the path lingering for a few seconds
 * instead of going immediately. Refusing to close locally because a teardown
 * request failed would leave the camera on.
 */
async function closeWhipSession(
  pc: RTCPeerConnection,
  resourceUrl: string | null,
): Promise<void> {
  if (resourceUrl) {
    try {
      await fetchWithTimeout(
        resourceUrl,
        { method: 'DELETE', keepalive: true },
        WHIP_DELETE_TIMEOUT_MS,
      );
    } catch (err) {
      console.warn('[whipClient] WHIP DELETE failed; closing locally anyway', err);
    }
  }
  pc.close();
}

/**
 * Apply the bitrate ceiling to an already-negotiated sender.
 *
 * Swallows its own failures. Every part of this is optional in some browser —
 * `getParameters` can return no encodings before the first frame, and
 * `setParameters` rejects outright on older Safari — and none of it is worth
 * failing a go-live over. The consequence of it not landing is a stream that
 * uses more uplink than the cost model assumes, which is a billing
 * inaccuracy, not a broken broadcast.
 */
async function applyEncoderCeiling(
  sender: RTCRtpSender,
  options: WhipPublishOptions,
): Promise<void> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = publishBitrateFor(options.quality);
    if (options.maxFramerate) params.encodings[0].maxFramerate = options.maxFramerate;
    await sender.setParameters(params);
  } catch (err) {
    console.warn('[whipClient] could not apply encoder ceiling', err);
  }
}

/**
 * Resolve once ICE has gathered everything, or once the timeout says enough.
 *
 * See ICE_GATHERING_TIMEOUT_MS for why a timeout rather than a plain wait.
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
    // Abort resolves rather than rejects: the caller checks the signal itself
    // on the next line, and that keeps one abort path instead of two.
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * `fetch` with a deadline, honouring a caller's own abort signal too.
 *
 * AbortSignal.any() would express this in one line and is not used: it is
 * unsupported on the iOS Safari versions this product still targets, and the
 * publisher path is exactly where that would be discovered — on a creator's
 * phone, at go-live.
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
  if (signal?.aborted) throw new WhipError('aborted', 'WHIP publish was aborted');
}

/** A failure with a machine-readable code, so the UI can say something specific. */
export class WhipError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WhipError';
    this.code = code;
  }
}

/**
 * Thai for a WHIP publish failure.
 *
 * The sibling of thaiForConnectError in ./livekitClient.ts, and it exists for
 * the same reason: the creator is looking at a camera preview that will not go
 * live, and "Failed to fetch" tells them nothing about whether to retry, check
 * their signal, or give up.
 */
export function thaiForWhipError(err: unknown): string {
  const code = err instanceof WhipError ? err.code : '';

  if (code === 'path_taken') {
    return 'ไลฟ์ก่อนหน้ายังปิดไม่สมบูรณ์ กรุณารอสักครู่แล้วลองใหม่';
  }
  if (code === 'no_video_track') {
    return 'ไม่พบสัญญาณกล้อง กรุณาตรวจสอบการอนุญาตใช้กล้องแล้วลองใหม่';
  }
  // Every 5xx from the origin is the same thing to a creator: our box, not
  // their phone. Said plainly rather than as a status code.
  if (/^http_5\d\d$/.test(code)) {
    return 'เซิร์ฟเวอร์ไลฟ์ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง';
  }
  if (code.startsWith('http_')) {
    return 'เริ่มไลฟ์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
  }
  // The remaining shapes — a TypeError from fetch, an aborted request, a
  // timeout — all mean the request did not complete, which for a creator on a
  // phone is overwhelmingly the network.
  return 'เชื่อมต่อเซิร์ฟเวอร์ไลฟ์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
}
