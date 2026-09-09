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
 *   PATCH <resource>              application/trickle-ice-sdpfrag, to re-key ICE
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
import {
  applyPublishEncoderParams,
  readOutboundVideoStats,
  type PublishVideoStats,
} from './encoderParams';

/** The log prefix every line from this publisher carries. */
const LOG = '[whipClient]';

/**
 * How often the sender's own account of itself is read while publishing.
 *
 * THE BLIND SPOT THIS CLOSES. `degradationPreference: 'maintain-framerate'`
 * tells WebRTC that when CPU or uplink is tight it may LOWER THE ENCODED
 * RESOLUTION to hold the framerate. It does that silently: a creator who
 * selected 1080p can be publishing 540p or 360p for the length of a broadcast
 * with every log line, every pill and every preview saying 1080p, because
 * every one of those describes what was ASKED FOR. The only place the truth
 * exists is `outbound-rtp`, and until this nobody read it.
 *
 * Five seconds is slow enough to be free (one getStats over a handful of
 * reports) and fast enough that a creator watching their own console sees a
 * drop while it is happening rather than afterwards.
 */
const WHIP_STATS_INTERVAL_MS = 5_000;

/**
 * How often an unchanged reading is repeated to the console.
 *
 * Every read would be 720 lines an hour saying the same thing, which is how a
 * useful log becomes one nobody reads. So a reading is logged when it CHANGES
 * — a different resolution, a different limitation reason, a different encoder
 * — and otherwise once a minute, which is enough for "it has been fine for the
 * last ten minutes" to be visible as well as claimed.
 */
const WHIP_STATS_HEARTBEAT_MS = 60_000;

/**
 * How long to wait for ICE candidate gathering before posting the offer anyway.
 *
 * This publisher is NON-TRICKLE: it posts one complete offer rather than
 * PATCHing candidates in as they arrive, because that is the half of WHIP
 * MediaMTX implements and it keeps the whole exchange to a single round trip.
 * (The one PATCH this file does send is an ICE RESTART, which is a different
 * use of the same verb and carries a complete candidate list of its own.)
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
  /**
   * Re-negotiate ICE in place, keeping the MediaMTX path alive.
   *
   * Resolves true when the restart was negotiated and the peer connection has a
   * fresh candidate pair to work with, false when it could not be — a server
   * that does not implement it, a resource that is gone, a browser that will
   * not build the offer. NEVER throws and never closes the connection on
   * failure: the caller's answer to false is the full re-handshake, which
   * discards this session anyway.
   *
   * WHY IT IS WORTH TRYING BEFORE THAT. A re-POST makes a NEW MediaMTX session
   * on the path, which restarts the HLS muxer, which breaks the playlist every
   * viewer is mid-segment on. An ICE restart is one PATCH and the muxer never
   * learns anything happened.
   */
  restartIce(signal?: AbortSignal): Promise<boolean>;
  /**
   * Re-cap the encoder's framerate on a session that is already publishing.
   *
   * WHY THIS EXISTS AT ALL. A composite — a screen share and a face in one
   * frame — is painted at 24fps rather than 30 (see COMPOSITE_FRAME_RATE), and
   * a share is started and stopped mid-broadcast. The cap has to follow it,
   * and it cannot be a re-publish: a new WHIP session on the same MediaMTX
   * path restarts the HLS muxer and breaks the playlist every viewer is
   * mid-segment on, which is a reconnect for the whole audience to change one
   * number in the encoder.
   *
   * WHAT IT BUYS. `maxFramerate` is what turns "the encoder cannot keep up"
   * into a dropped frame rather than a queued one. A queue is latency that
   * accumulates — the chart arriving seconds after the creator moved it, then
   * jumping to catch up — and no bitrate ceiling can spend its way out of it.
   * Capping at the rate the canvas is actually painted tells the encoder the
   * truth about its input and leaves it nothing to fall behind on.
   *
   * `setParameters`-based and therefore in-band: no renegotiation, no track
   * replacement, nothing a viewer can see. Never throws — a browser that
   * refuses leaves the previous cap standing, which is the behaviour before
   * this existed.
   */
  setMaxFramerate(fps: number): Promise<void>;
  /**
   * โหมดกราฟ: tell the encoder the frame it is being handed is a CHART.
   *
   * ONE CALL, BOTH NUMBERS, because they always move together and because
   * `setParameters` reads its object whole — two calls would be two round
   * trips with a window in between where one had landed and the other had not.
   *
   * WHAT CHART MODE CHANGES, and why each is the opposite of the camera-only
   * choice PR #63 made (the values themselves live in ./encoderParams, which
   * is the one place both publishers read them from):
   *
   *   degradationPreference   'maintain-resolution', not 'maintain-framerate'.
   *                           A chart may drop a frame; it may never drop
   *                           pixels. Holding the framerate is right for a
   *                           face — a stutter on a person is what a viewer
   *                           notices — and it is exactly wrong for a chart,
   *                           where the softening it trades away IS the
   *                           content. A candle at 22fps is a candle; a candle
   *                           at 540p is a smudge.
   *   scaleResolutionDownBy   1, written explicitly, so nothing in the layer
   *                           or adaptation machinery can halve the frame
   *                           behind the preference.
   *   maxBitrate              1.5x the rung. See CHART_MODE_BITRATE_MULTIPLIER
   *                           — thin lines are where an H.264 encoder at the
   *                           ladder's own ceiling starts blocking.
   *
   * SCOPED TO A DESKTOP SCREEN SHARE, by the caller. The mobile dual-camera
   * composite calls `setMaxFramerate` and not this: its top slot is a back
   * camera, which is a moving picture of the world and wants the camera's
   * trade, not a document's.
   *
   * Reverting is the same call with `chartMode: false`, which restores every
   * PR #63 value exactly. Never throws — see applyPublishEncoderParams.
   */
  setEncoderMode(options: { maxFramerate?: number; chartMode?: boolean }): Promise<void>;
  /**
   * What the encoder is actually sending, right now. See PublishVideoStats.
   *
   * Null before the first frame is encoded (there is no `outbound-rtp` report
   * yet) and null where the browser reports no video sender at all. The
   * session polls this itself every WHIP_STATS_INTERVAL_MS and logs it; this
   * is the same read, exposed so the ?debug=camera chip can show a creator the
   * encoder's real resolution beside the one they chose.
   */
  getVideoStats(): Promise<PublishVideoStats | null>;
  /**
   * Swap the track a sender is publishing, WITHOUT renegotiating.
   *
   * WHY THIS EXISTS (PR #67). iOS ends camera and microphone tracks when the
   * page goes to the background. `readyState` becomes 'ended' and it never
   * comes back: the OS took the device away, and a track in that state cannot
   * be revived by anything — not by the ICE restart, not by the re-handshake
   * ladder, not by waiting. The only fix is a FRESH getUserMedia and a new
   * track put where the old one was. So a creator who checked a notification
   * mid-broadcast came back publishing silence, or a frozen picture, with a
   * peer connection that reported itself perfectly healthy throughout.
   *
   * `replaceTrack` is the standard way to do that and it is in-band: the m-line
   * does not move, no offer/answer is exchanged, MediaMTX never learns anything
   * happened, and no viewer sees a stall. A renegotiation would make a NEW
   * MediaMTX session on the path, which restarts the HLS muxer and breaks the
   * playlist every viewer is mid-segment on — the whole audience reconnecting
   * so that one creator's microphone could come back.
   *
   * Returns false when there is no sender of that kind (a session published
   * without a microphone) or the browser refused. Never throws: the caller's
   * fallback is the full re-handshake, and a broadcast must not end because a
   * recovery attempt did.
   *
   * NOTE ON THE VIDEO SENDER. What this publisher sends is the FILTER CANVAS,
   * not the camera — see cameraFilters.createFilteredStream — so re-acquiring a
   * camera does not go through here at all: the canvas is pointed at the new
   * source and keeps painting. `replaceVideoTrack` is for the case where the
   * canvas track ITSELF was ended.
   */
  replaceVideoTrack(track: MediaStreamTrack | null): Promise<boolean>;
  /** The same, for the microphone. See replaceVideoTrack. */
  replaceAudioTrack(track: MediaStreamTrack | null): Promise<boolean>;
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

    /**
     * H.264 first in the offer. Without this the origin path delivers audio.
     *
     * MediaMTX muxes WHIP straight into HLS, and HLS carries H.264/H.265 only.
     * Chrome offers VP8 ahead of H.264, MediaMTX accepts what it is offered,
     * and then drops the track it cannot mux — which in the origin-sg-1 logs
     * reads as:
     *
     *   [WebRTC] [session ...] is publishing ..., 2 tracks (Opus, VP8)
     *   [HLS] [muxer ...] skipping track 2 (VP8)
     *   [HLS] [muxer ...] is converting into HLS, 1 track (Opus)
     *
     * A broadcast that publishes successfully and delivers a black screen with
     * sound. iPhone publishers never hit it — Safari offers H.264 first — which
     * is exactly why it survived the first round of origin testing.
     *
     * Exported so /dev/live-chart's loopback peer connection negotiates the
     * same codec this publisher does: an encoder's behaviour under pressure is
     * a property OF THE CODEC, and a bench measuring VP8 would be measuring
     * something no creator publishes.
     */
    preferH264(videoTransceiver);

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
    /**
     * The publish always begins in camera-only terms, whatever it will become.
     *
     * A share cannot already be running here — the studio mounts one only
     * after the session is live — so starting in chart mode would be asserting
     * something about a frame that does not exist yet. `setEncoderMode` is
     * what moves it, in-band, the moment a share actually starts.
     */
    await applyPublishEncoderParams(videoTransceiver.sender, {
      quality: options.quality,
      maxFramerate: options.maxFramerate,
      chartMode: false,
      label: LOG,
    });

    await waitForIceGathering(pc, options.signal);
    throwIfAborted(options.signal);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw new WhipError('no_local_sdp', 'Local description was never set');

    const { answerSdp, resourceUrl, etag } = await postOffer(
      options.endpoint,
      localSdp,
      options.signal,
    );

    throwIfAborted(options.signal);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    /**
     * The answer, kept and updated in place.
     *
     * An ICE restart is answered with an SDP FRAGMENT — new credentials and
     * candidates, nothing else — and `setRemoteDescription` will not take one.
     * The fragment is folded into this full description instead, so what goes
     * back into the peer connection is still a complete answer. It is therefore
     * mutable state for the life of the session, not a value.
     */
    let remoteSdp = answerSdp;

    /**
     * The two encoder numbers this session currently stands behind.
     *
     * Held here rather than read back off the sender because `getParameters`
     * reports what the BROWSER settled on, clamps included, and writing that
     * back as if it were the request would let one clamp become permanent.
     * These are the asks; the readback in applyEncoderCeiling says what
     * happened to them.
     */
    let currentFramerate = options.maxFramerate;
    let chartMode = false;

    /** The previous stats read, so the next one can derive a bitrate. */
    let previousStats: PublishVideoStats | null = null;
    let statsTimer: ReturnType<typeof setInterval> | null = null;
    let firstStatsTimer: ReturnType<typeof setTimeout> | null = null;
    /** performance.now() of the last line actually printed. See the heartbeat. */
    let lastLoggedAt = 0;
    /** What that line said, so an unchanged reading can stay quiet. */
    let lastLoggedKey = '';

    const readVideoStats = async (): Promise<PublishVideoStats | null> => {
      const stats = await readOutboundVideoStats(videoTransceiver.sender, previousStats);
      if (stats) previousStats = stats;
      return stats;
    };

    const stopStatsPolling = () => {
      if (statsTimer !== null) {
        clearInterval(statsTimer);
        statsTimer = null;
      }
      // The opening read too: a broadcast torn down inside the first second and
      // a half would otherwise call getStats on a closed sender, which throws
      // and logs a warning about a session nobody is publishing.
      if (firstStatsTimer !== null) {
        clearTimeout(firstStatsTimer);
        firstStatsTimer = null;
      }
    };

    /**
     * THE LINE THAT WOULD HAVE CAUGHT THIS MONTHS AGO.
     *
     * A creator on 1080p whose encoder has quietly settled at 960x540 under
     * `cpu` looks, in every other log this pipeline writes, exactly like a
     * creator on 1080p. This prints the difference, with the reason attached,
     * from the machine it is happening on.
     *
     * Quiet by default: printed when the reading CHANGES, and otherwise once
     * a minute. See WHIP_STATS_HEARTBEAT_MS.
     */
    const pollStats = () => {
      void readVideoStats().then((stats) => {
        if (!stats) return;
        const key =
          `${stats.frameWidth}x${stats.frameHeight}|${stats.qualityLimitationReason}|` +
          `${stats.encoderImplementation}|${chartMode}`;
        const at = performance.now();
        if (key === lastLoggedKey && at - lastLoggedAt < WHIP_STATS_HEARTBEAT_MS) return;
        lastLoggedKey = key;
        lastLoggedAt = at;
        const limited = stats.qualityLimitationReason && stats.qualityLimitationReason !== 'none';
        const line = {
          mode: chartMode ? 'chart' : 'camera',
          quality: options.quality,
          sending: `${stats.frameWidth ?? '?'}x${stats.frameHeight ?? '?'}`,
          fps: stats.framesPerSecond,
          bitrate: stats.bitrate === null ? null : Math.round(stats.bitrate / 1_000) + 'kbps',
          qualityLimitationReason: stats.qualityLimitationReason,
          qualityLimitationDurations: stats.qualityLimitationDurations,
          encoder: stats.encoderImplementation,
          powerEfficient: stats.powerEfficientEncoder,
          codec: stats.codec,
        };
        // A limited encoder is a warning because it is a picture the creator
        // is not getting and cannot see they are not getting; an unlimited one
        // is information.
        if (limited) console.warn('[whipClient] outbound video — LIMITED', line);
        else console.info('[whipClient] outbound video', line);
      });
    };

    statsTimer = setInterval(pollStats, WHIP_STATS_INTERVAL_MS);
    // One read shortly after the handshake, so the opening resolution is in
    // the console before anyone thinks to look for it. Not immediate: there is
    // no outbound-rtp report until frames have actually been encoded.
    firstStatsTimer = setTimeout(() => {
      firstStatsTimer = null;
      pollStats();
    }, 1_500);

    return {
      pc,
      resourceUrl,
      restartIce: async (signal) => {
        const updated = await restartWhipIce(pc, resourceUrl, remoteSdp, etag, signal);
        if (!updated) return false;
        remoteSdp = updated;
        return true;
      },
      replaceVideoTrack: (track) => replaceSenderTrack(videoTransceiver.sender, track, 'video'),
      replaceAudioTrack: (track) => {
        const sender = pc.getSenders().find((candidate) => candidate.track?.kind === 'audio');
        // A sender is found by the kind of the track it HOLDS, so a session
        // whose microphone track has already ended still has one — an ended
        // track keeps its kind. The `?? null` case is a session published with
        // no microphone at all, which has no audio sender to replace into.
        return replaceSenderTrack(sender ?? null, track, 'audio');
      },
      setMaxFramerate: async (fps) => {
        // The bitrate ceiling is re-applied alongside it, because
        // `setParameters` reads the whole object: a call that carried only the
        // framerate would be writing back whatever the browser currently
        // holds for the bitrate, which after a clamp is not what was asked
        // for. One writer for both numbers, always.
        currentFramerate = fps;
        await applyPublishEncoderParams(videoTransceiver.sender, {
          quality: options.quality,
          maxFramerate: currentFramerate,
          chartMode,
          label: LOG,
        });
      },
      setEncoderMode: async ({ maxFramerate, chartMode: nextChartMode }) => {
        // Both remembered before the write, so a later setMaxFramerate cannot
        // silently drop chart mode by writing back the object without it —
        // which is the exact bug shape `setParameters` reading its object
        // whole invites.
        if (maxFramerate !== undefined) currentFramerate = maxFramerate;
        if (nextChartMode !== undefined) chartMode = nextChartMode;
        await applyPublishEncoderParams(videoTransceiver.sender, {
          quality: options.quality,
          maxFramerate: currentFramerate,
          chartMode,
          label: LOG,
        });
        // Read the encoder's own account of itself on the NEXT poll rather
        // than now: the frames encoded under the new parameters do not exist
        // yet, so a read here would report the mode that was just left.
        lastLoggedAt = 0;
      },
      getVideoStats: () => readVideoStats(),
      close: async () => {
        stopStatsPolling();
        await closeWhipSession(pc, resourceUrl);
      },
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
): Promise<{ answerSdp: string; resourceUrl: string | null; etag: string | null }> {
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

  /**
   * Kept for the `If-Match` on an ICE-restart PATCH.
   *
   * RFC 9725 lets a server require the session's entity tag on every write to
   * the resource. It is optional, and MediaMTX does not send one today, so this
   * is null far more often than not — the PATCH just omits the header then.
   */
  const etag = response.headers.get('ETag');

  return { answerSdp, resourceUrl, etag };
}

/**
 * Reorder the video transceiver's codecs so H.264 is offered first.
 *
 * REORDERS, NEVER FILTERS. It would be tempting to hand back only the H.264
 * entries, but the capability list also carries `rtx` (retransmission), `red`
 * and `ulpfec`, and dropping those from the offer costs the loss recovery this
 * publisher needs most on a phone.
 *
 * Packetization-mode 1 is put ahead of the rest of the H.264 entries: mode 0
 * carries one NAL unit per packet and cannot fragment a keyframe across the
 * MTU, which is the wrong shape for a 720p broadcast, and FU-A — the
 * fragmentation mode 1 enables — is what MediaMTX's depacketizer expects.
 *
 * Every step is optional somewhere. `setCodecPreferences` did not exist on
 * Safari before 15.4, `getCapabilities` can return null, and the call itself
 * throws if the browser dislikes the list. None of that is worth failing a
 * go-live over: the fallback is the browser's own order, which is what shipped
 * before this function existed.
 */
export function preferH264(transceiver: RTCRtpTransceiver): void {
  if (typeof RTCRtpTransceiver === 'undefined') return;
  if (!('setCodecPreferences' in RTCRtpTransceiver.prototype)) return;

  // Sender capabilities, not receiver: this transceiver is `sendonly`, so the
  // question is what this browser can ENCODE. The receiver set is a superset
  // and can name codecs the encoder has no support for.
  const codecs =
    RTCRtpSender.getCapabilities?.('video')?.codecs ??
    RTCRtpReceiver.getCapabilities?.('video')?.codecs;
  if (!codecs || codecs.length === 0) return;

  const isH264 = (codec: RTCRtpCodec) => codec.mimeType.toLowerCase() === 'video/h264';
  if (!codecs.some(isH264)) {
    console.warn('[whipClient] no H.264 encoder on this browser; HLS output will be audio-only');
    return;
  }

  const fragmentable = (codec: RTCRtpCodec) =>
    codec.sdpFmtpLine?.includes('packetization-mode=1') ?? false;

  const ordered = [
    ...codecs.filter((codec) => isH264(codec) && fragmentable(codec)),
    ...codecs.filter((codec) => isH264(codec) && !fragmentable(codec)),
    ...codecs.filter((codec) => !isH264(codec)),
  ];

  try {
    transceiver.setCodecPreferences(ordered);
  } catch (err) {
    console.warn('[whipClient] setCodecPreferences failed; using the default order', err);
  }
}

/**
 * Re-negotiate ICE on a live session, per the ICE-restart half of RFC 9725.
 *
 * The exchange is one request:
 *
 *   PATCH <resource>   Content-Type: application/trickle-ice-sdpfrag
 *                      body = the new local ufrag/pwd and candidates
 *     200 OK           body = the server's new ufrag/pwd and candidates
 *
 * Returns the UPDATED REMOTE SDP on success and null on every failure. Null is
 * a normal outcome, not an error to report: a WHIP server is allowed to
 * implement none of this, and the caller's answer to null is the full
 * re-handshake it would have done anyway.
 */
async function restartWhipIce(
  pc: RTCPeerConnection,
  resourceUrl: string | null,
  remoteSdp: string,
  etag: string | null,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  // Without a Location there is no resource to PATCH. Nothing else to try.
  if (!resourceUrl) return null;
  if (pc.signalingState === 'closed') return null;
  // A restart is only meaningful from a settled session. Mid-negotiation the
  // offer that is already in flight is the one that will fix this.
  if (pc.signalingState !== 'stable') return null;

  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, signal);
    if (signal?.aborted) return null;

    const fragment = buildIceRestartFragment(pc.localDescription?.sdp ?? '');
    if (!fragment) return rollbackLocalOffer(pc);

    const response = await fetchWithTimeout(
      resourceUrl,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/trickle-ice-sdpfrag',
          ...(etag ? { 'If-Match': etag } : {}),
        },
        body: fragment,
        signal,
      },
      WHIP_REQUEST_TIMEOUT_MS,
    );

    if (!response.ok) {
      // 405 and 501 mean "this server does not do ICE restarts", 404 means the
      // session is already gone. All three are the same instruction to the
      // caller: stop trying to save this connection and build a new one.
      console.warn(`[whipClient] ICE restart refused (HTTP ${response.status})`);
      return rollbackLocalOffer(pc);
    }

    const updated = applyIceRestartAnswer(remoteSdp, await response.text());
    if (!updated) return rollbackLocalOffer(pc);

    await pc.setRemoteDescription({ type: 'answer', sdp: updated });
    return updated;
  } catch (err) {
    console.warn('[whipClient] ICE restart failed', err);
    return rollbackLocalOffer(pc);
  }
}

/**
 * Put the peer connection back in `stable` after an abandoned restart.
 *
 * Cosmetic in the common case — the caller answers null by closing this
 * connection and building a new one — but not always: a `disconnected` that
 * recovers on its own while the PATCH was failing leaves a session that is
 * still publishing, and one stuck in `have-local-offer` could never be
 * restarted again. Always returns null, so callers can `return` it directly.
 */
function rollbackLocalOffer(pc: RTCPeerConnection): null {
  if (pc.signalingState === 'have-local-offer') {
    void pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
  }
  return null;
}

/**
 * The SDP fragment an ICE restart is requested with (the `sdpfrag` of RFC 8840).
 *
 * A fragment is not an SDP: no `v=`, no `o=`, no `c=`. It is the session-level
 * ICE credentials followed by one stanza per m-section carrying that section's
 * mid, its credentials and its candidates. `a=end-of-candidates` is what tells
 * a non-trickle server the list is complete — without it MediaMTX would wait
 * for candidates that are never coming.
 *
 * Exported for tests: this is string surgery on a format with no parser in the
 * browser, and it is the one part of the restart path that can be checked
 * without a peer connection and a server.
 */
export function buildIceRestartFragment(localSdp: string): string | null {
  const sections = splitSdpSections(localSdp);
  if (sections.media.length === 0) return null;

  const ufrag = firstValue([...sections.session, ...sections.media.flat()], 'a=ice-ufrag:');
  const pwd = firstValue([...sections.session, ...sections.media.flat()], 'a=ice-pwd:');
  if (!ufrag || !pwd) return null;

  const lines = [`a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`];

  for (const section of sections.media) {
    const mid = firstValue(section, 'a=mid:');
    lines.push(section[0]);
    if (mid) lines.push(`a=mid:${mid}`);
    lines.push(`a=ice-ufrag:${firstValue(section, 'a=ice-ufrag:') ?? ufrag}`);
    lines.push(`a=ice-pwd:${firstValue(section, 'a=ice-pwd:') ?? pwd}`);
    lines.push(...section.filter((line) => line.startsWith('a=candidate:')));
    lines.push('a=end-of-candidates');
  }

  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Fold the server's answering fragment back into the full remote description.
 *
 * `setRemoteDescription` takes complete descriptions only, so the previous
 * answer is rewritten in place: every ICE credential is replaced with the new
 * one, and the old candidates are swapped for the ones the server just sent.
 *
 * A fragment with NO candidates is honoured rather than rejected — a server
 * whose address has not changed is entitled to re-key ICE and re-offer nothing
 * — so in that case the previous candidates are kept.
 *
 * Returns null when the fragment carries no credentials at all, which is the
 * signal that the server did not really do a restart.
 *
 * Exported for tests, with buildIceRestartFragment.
 */
export function applyIceRestartAnswer(remoteSdp: string, fragment: string): string | null {
  const fragmentLines = splitLines(fragment);
  const ufrag = firstValue(fragmentLines, 'a=ice-ufrag:');
  const pwd = firstValue(fragmentLines, 'a=ice-pwd:');
  if (!ufrag || !pwd) return null;

  const candidates = fragmentLines.filter((line) => line.startsWith('a=candidate:'));
  const out: string[] = [];

  for (const line of splitLines(remoteSdp)) {
    if (line.startsWith('a=ice-ufrag:')) {
      out.push(`a=ice-ufrag:${ufrag}`);
      continue;
    }
    if (line.startsWith('a=ice-pwd:')) {
      out.push(`a=ice-pwd:${pwd}`);
      // The new candidates go where the old ones were: immediately after the
      // credentials they belong to, and inside the m-section they apply to.
      if (candidates.length > 0) out.push(...candidates);
      continue;
    }
    // Dropped only when there is something to replace them with.
    if (candidates.length > 0 && line.startsWith('a=candidate:')) continue;
    out.push(line);
  }

  return `${out.join('\r\n')}\r\n`;
}

/** SDP lines, however the peer sent its line endings, with blanks dropped. */
function splitLines(sdp: string): string[] {
  return sdp.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
}

/** An SDP split into its session part and one array per m-section. */
function splitSdpSections(sdp: string): { session: string[]; media: string[][] } {
  const session: string[] = [];
  const media: string[][] = [];

  for (const line of splitLines(sdp)) {
    if (line.startsWith('m=')) {
      media.push([line]);
    } else if (media.length > 0) {
      media[media.length - 1].push(line);
    } else {
      session.push(line);
    }
  }

  return { session, media };
}

/** The value of the first line with this prefix, or null. */
function firstValue(lines: string[], prefix: string): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

/**
 * Put a new track into a sender, and say plainly whether it went in.
 *
 * The `enabled` flag is carried across, because it is what the mic button
 * toggles: a creator who was muted when iOS took their microphone away must not
 * come back from the background unmuted, broadcasting a room they think is off.
 */
async function replaceSenderTrack(
  sender: RTCRtpSender | null,
  track: MediaStreamTrack | null,
  kind: 'video' | 'audio',
): Promise<boolean> {
  if (!sender) {
    console.warn(`[whip] no ${kind} sender to replace into`);
    return false;
  }
  if (track && sender.track) track.enabled = sender.track.enabled;
  try {
    await sender.replaceTrack(track);
    console.info(`[whip] ${kind} track replaced`, {
      ready_state: track?.readyState ?? 'null',
      enabled: track?.enabled ?? null,
    });
    return true;
  } catch (err) {
    console.warn(`[whip] ${kind} replaceTrack refused`, err);
    return false;
  }
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
