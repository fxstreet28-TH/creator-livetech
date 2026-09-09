/**
 * THE ENCODER'S PARAMETERS, AND THE ONE PLACE THAT OWNS THEM.
 *
 * WHY THIS IS A MODULE AND NOT A FUNCTION IN A PUBLISHER. There are two
 * publishers — the WHIP sender that carries `delivery_mode = 'origin'` and the
 * LiveKit one behind every other mode — and until this they disagreed about
 * the encoder without either of them being wrong. Each set
 * `degradationPreference` and a bitrate ceiling in its own way, at its own
 * moment, with its own copy of the reasoning in a comment, and neither could
 * see the other. That was survivable while the answer never changed. It stops
 * being survivable with โหมดกราฟ, which flips two of those settings MID-
 * BROADCAST and has to flip them the same way on both paths, because the thing
 * they describe — a shared chart in a composited frame — is the same picture
 * whichever socket carries it.
 *
 * So the parameters live here, applied through one function against an
 * `RTCRtpSender`, which is what both publishers ultimately hold: the WHIP one
 * from its own transceiver, the LiveKit one from `LocalVideoTrack.sender`.
 *
 * WHAT IS DECIDED HERE, in one sentence each:
 *
 *   maxBitrate             the rung's ceiling, raised by half in chart mode.
 *                          See publishBitrateFor and CHART_MODE_BITRATE_MULTIPLIER.
 *   maxFramerate           what the canvas is actually painted at — 30 camera
 *                          -only, 24 while compositing. What makes a frame the
 *                          encoder cannot finish a DROPPED frame rather than a
 *                          queued one, which is the accumulating lag PR #64 was
 *                          about.
 *   degradationPreference  what to give up when the ceiling is not enough:
 *                          resolution for a face, framerate for a chart.
 *   scaleResolutionDownBy  1, in chart mode, so nothing can halve the frame
 *                          behind the preference's back.
 *
 * AND WHAT IS READ BACK. `setParameters` resolving is not evidence the encoder
 * took the value, and `outbound-rtp` is the only place the published
 * resolution is a fact rather than a request. Both live here for the same
 * reason: the question "is the chart reaching the viewer at the size it was
 * composed at?" is one question, and it should have one answer whichever
 * publisher is asked.
 */

import type { BroadcastQuality } from './types';
import { publishBitrateFor } from './constants';

/**
 * WHAT THE ENCODER IS ACTUALLY DOING, as opposed to what it was asked for.
 *
 * Every field is read straight off the `outbound-rtp` video report and its
 * codec, with no interpretation: this type exists so that "the chart is soft"
 * can be answered with numbers from the machine it is soft on.
 *
 * Null on any field the browser does not report. Chrome fills all of them,
 * Safari fills most, and a missing number must read as "not said" rather than
 * as a zero somebody could mistake for a measurement.
 */
export interface PublishVideoStats {
  /**
   * THE HEADLINE. What is leaving this machine, in pixels.
   *
   * Compare it against the canvas being published: equal means the encoder is
   * sending what was composed, and smaller means WebRTC quietly scaled it down
   * — which for a chart is the whole difference between a readable price axis
   * and a smear.
   */
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  /**
   * WHY it scaled down, when it did: 'none', 'cpu', 'bandwidth' or 'other'.
   *
   * The two that matter read differently. 'bandwidth' is the uplink and is
   * often momentary — a lift, a handover, a neighbour on the same WiFi.
   * 'cpu' is this machine failing to encode what it is being handed, which no
   * network will fix and which in chart mode means the rung is too high for
   * the hardware.
   */
  qualityLimitationReason: string | null;
  /** Seconds spent in each reason since the session began. A cumulative total. */
  qualityLimitationDurations: Record<string, number> | null;
  /** Measured across the gap between two reads, in bits/second. Null on the first. */
  bitrate: number | null;
  /**
   * The encoder behind the track: a hardware one on a healthy desktop,
   * 'libvpx'/'OpenH264' or similar where the browser fell back to software.
   *
   * Reported rather than acted on. It is the number that says whether a rung
   * is viable on THIS machine, and a software encoder at 1080x1920@24 with a
   * chart in the frame is the shape of failure that reads as 'cpu' above.
   */
  encoderImplementation: string | null;
  /** Chrome's own verdict on whether that encoder is the power-efficient path. */
  powerEfficientEncoder: boolean | null;
  /** The codec actually negotiated, e.g. 'video/H264'. Confirms preferH264 landed. */
  codec: string | null;
  /** Cumulative, and only used to derive `bitrate`. Kept so the next read can. */
  bytesSent: number;
  /** performance.now() at the read, for the same reason. */
  readAt: number;
}

/**
 * Apply every encoder parameter to an already-negotiated sender, at once.
 *
 * Swallows its own failures. Every part of this is optional in some browser —
 * `getParameters` can return no encodings before the first frame, and
 * `setParameters` rejects outright on older Safari — and none of it is worth
 * failing a go-live over. The consequence of it not landing is a stream that
 * uses more uplink than the cost model assumes, which is a billing
 * inaccuracy, not a broken broadcast.
 */
export interface PublishEncoderParams {
  quality: BroadcastQuality;
  /** What the canvas is painted at: 30 camera-only, COMPOSITE_FRAME_RATE while sharing. */
  maxFramerate?: number;
  /** โหมดกราฟ. See the note on degradationPreference below for what it flips. */
  chartMode: boolean;
  /**
   * Which publisher is asking, for the log line. '[whipClient]' or '[livekit]'.
   *
   * A prefix rather than a shared one because the two paths fail differently
   * and a console filtered to one of them must not silently include the other.
   */
  label: string;
}

export async function applyPublishEncoderParams(
  sender: RTCRtpSender,
  { quality, maxFramerate, chartMode, label }: PublishEncoderParams,
): Promise<void> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const requested = publishBitrateFor(quality, chartMode);
    params.encodings[0].maxBitrate = requested;
    if (maxFramerate) params.encodings[0].maxFramerate = maxFramerate;

    /**
     * NOTHING MAY HALVE THE FRAME. Said out loud, in chart mode only.
     *
     * 1 is the default, so this changes nothing on a healthy sender — which is
     * the point: it is the belt to `maintain-resolution`'s braces, and it
     * closes the one path that preference does not. A leftover value from a
     * simulcast layer, or a browser that applies its own scaling before the
     * degradation logic ever runs, would hand the encoder a half-size frame
     * and report no limitation at all, because from WebRTC's point of view
     * nothing degraded: it was asked for half.
     *
     * NOT WRITTEN IN CAMERA-ONLY MODE, deliberately. Every PR #63 parameter
     * stays byte-for-byte what it was there, and a face has no need of this.
     */
    if (chartMode) params.encodings[0].scaleResolutionDownBy = 1;

    /**
     * WHAT TO GIVE UP FIRST when the ceiling is not enough.
     *
     * WebRTC's default balances resolution against framerate. For this product
     * that is the wrong trade in one direction: a dropped framerate reads as
     * ภาพสะดุด — the stutter Por recorded — while a brief softening of a 720p
     * picture on a phone held at arm's length is close to invisible. So the
     * encoder is told to hold the framerate and spend resolution.
     *
     * This is the half of the fix that matters when the ceiling is reached
     * ANYWAY. 6 Mbps is more headroom, not infinite headroom, and very high
     * motion will still find the top of it; what changes is that finding it
     * now costs sharpness for a second instead of a visible hitch.
     *
     * Set on the same parameters object as the ceiling, in the same
     * setParameters call, because each call reads the object whole — writing
     * it separately would mean a second round trip and a window where one of
     * the two had landed and the other had not.
     *
     * `maintain-framerate` protects the 30fps this pipeline already asks for.
     * It does not raise it.
     *
     * ---------------------------------------------------------------------
     * AND WHY โหมดกราฟ REVERSES IT.
     * ---------------------------------------------------------------------
     *
     * Everything above is an argument about a FACE, and it is correct about a
     * face. A chart is the other content, and every clause flips with it: the
     * "brief softening of a 720p picture on a phone held at arm's length" is
     * close to invisible on a person and is the entire failure on a chart,
     * where 1px wicks and 11px axis labels are what the viewer came for and
     * are the first things a downscale destroys. Meanwhile the stutter this
     * preference protects against is bounded — the composite is already capped
     * at 24fps, a chart scrolls in discrete steps, and a chart at 21fps reads
     * as a chart.
     *
     * So while a share is up the encoder is told the opposite: hold the
     * pixels, drop a frame if you must. It is the single most load-bearing
     * line in chart mode, because it is the one that stops the silent
     * downscale that no log, pill or preview was reporting.
     */
    params.degradationPreference = chartMode ? 'maintain-resolution' : 'maintain-framerate';
    await sender.setParameters(params);

    /**
     * Read the ceiling BACK, and say what actually landed.
     *
     * `setParameters` resolving is not evidence the encoder took the value:
     * the browser is free to clamp it, drop the encoding entry, or accept the
     * promise and keep its own default — which is exactly the failure that
     * cannot be told apart from a healthy publish by looking at the picture,
     * because a stream at a third of its intended bitrate publishes fine and
     * simply looks soft. The 2026-09-08 origin test surfaced as "signal is
     * weak" with nothing in any log to confirm or rule out the encoder, and
     * this line is what makes the next one answerable from a phone console.
     *
     * Reported, not enforced. A resolved value below the request is a real
     * browser decision (a thermal or uplink clamp) and re-asserting it in a
     * loop would fight the encoder for no gain.
     */
    const applied = sender.getParameters();
    const resolved = applied.encodings?.[0]?.maxBitrate;
    /**
     * The framerate cap, read back for the same reason the bitrate is.
     *
     * This is the number that decides whether an encoder under pressure drops
     * a frame or queues it, and the difference between those two is the whole
     * of the reported stutter: a drop is a momentary dip nobody names, a queue
     * is latency that grows until the picture catches up in a lurch. A browser
     * that quietly kept its own default here would look identical in every log
     * except this one.
     */
    const resolvedFramerate = applied.encodings?.[0]?.maxFramerate ?? null;
    // Read back for the same reason as the rest: a browser that ignored the
    // explicit 1 is a browser that may still be halving the chart, and the
    // picture looks merely soft either way.
    const resolvedScale = applied.encodings?.[0]?.scaleResolutionDownBy ?? null;
    // Read back alongside the ceiling and for the same reason: a browser is
    // free to accept the promise and keep its own preference, and the
    // difference is invisible in the picture until someone is moving.
    const degradation = applied.degradationPreference ?? null;
    if (resolved === requested) {
      console.info(`${label} encoder ceiling applied`, {
        mode: chartMode ? 'chart' : 'camera',
        quality,
        maxBitrate: resolved,
        maxFramerate: resolvedFramerate,
        degradationPreference: degradation,
        scaleResolutionDownBy: resolvedScale,
      });
    } else {
      console.warn(`${label} encoder ceiling did not stick`, {
        mode: chartMode ? 'chart' : 'camera',
        quality,
        requested,
        resolved: resolved ?? null,
        maxFramerate: resolvedFramerate,
        degradationPreference: degradation,
        scaleResolutionDownBy: resolvedScale,
      });
    }
  } catch (err) {
    console.warn(`${label} could not apply encoder ceiling`, err);
  }
}

/**
 * Read the `outbound-rtp` video report, and the codec beside it.
 *
 * THE ANSWER TO "WHAT IS ACTUALLY BEING SENT?", and it has to be readable from
 * somewhere other than a live broadcast: /dev/live-chart drives a loopback peer
 * connection with exactly this function pointed at it, which is how the
 * encoder's behaviour under chart mode is checkable without a creator, a
 * monitor and an iPhone in the room.
 *
 * `previous` is the last reading from THIS sender, and the only thing it is
 * used for is the bitrate: WebRTC reports `bytesSent` cumulatively, so a rate
 * only exists across a gap between two reads. A first read has no gap and
 * therefore honestly reports `bitrate: null` rather than dividing by the
 * session's whole lifetime, which would read low for the length of a
 * broadcast and describe nothing that is happening now.
 *
 * Never throws: this is diagnostics, and a broadcast must not end because a
 * stats read did. A browser with no report yet, or none at all, is null.
 */
export async function readOutboundVideoStats(
  sender: RTCRtpSender,
  previous: PublishVideoStats | null,
): Promise<PublishVideoStats | null> {
  try {
    const report = await sender.getStats();
    let outbound: RTCOutboundRtpStreamStats | null = null;
    // The codec is a report of its own, referenced by id from the outbound
    // one — so it takes a second pass over the same map rather than a lookup.
    const codecs = new Map<string, string>();
    report.forEach((entry) => {
      if (entry.type === 'outbound-rtp' && (entry as RTCOutboundRtpStreamStats).kind === 'video') {
        outbound = entry as RTCOutboundRtpStreamStats;
      } else if (entry.type === 'codec') {
        // RTCRtpCodecStats is not in this TypeScript lib's DOM types; the two
        // fields read off it are the two the spec has always had.
        const codec = entry as { id: string; mimeType: string };
        codecs.set(codec.id, codec.mimeType);
      }
    });
    if (!outbound) return null;

    /**
     * Fields the TypeScript DOM lib does not carry, read off the same object.
     *
     * `qualityLimitationReason`, `qualityLimitationDurations`,
     * `encoderImplementation` and `powerEfficientEncoder` are all in the
     * WebRTC stats spec and all present in Chrome; the lib's
     * RTCOutboundRtpStreamStats is simply behind. Cast once, here, rather than
     * `as any` at four call sites.
     */
    const raw = outbound as RTCOutboundRtpStreamStats & {
      qualityLimitationReason?: string;
      qualityLimitationDurations?: Record<string, number>;
      encoderImplementation?: string;
      powerEfficientEncoder?: boolean;
      frameWidth?: number;
      frameHeight?: number;
      framesPerSecond?: number;
      codecId?: string;
      bytesSent?: number;
    };

    const readAt = performance.now();
    const bytesSent = raw.bytesSent ?? 0;
    const elapsedMs = previous ? readAt - previous.readAt : 0;
    const bitrate =
      previous && elapsedMs > 0 && bytesSent >= previous.bytesSent
        ? ((bytesSent - previous.bytesSent) * 8 * 1000) / elapsedMs
        : null;

    return {
      frameWidth: raw.frameWidth ?? null,
      frameHeight: raw.frameHeight ?? null,
      framesPerSecond: raw.framesPerSecond ?? null,
      qualityLimitationReason: raw.qualityLimitationReason ?? null,
      qualityLimitationDurations: raw.qualityLimitationDurations ?? null,
      bitrate,
      encoderImplementation: raw.encoderImplementation ?? null,
      powerEfficientEncoder: raw.powerEfficientEncoder ?? null,
      codec: raw.codecId ? (codecs.get(raw.codecId) ?? null) : null,
      bytesSent,
      readAt,
    };
  } catch (err) {
    console.warn('[publish] could not read outbound stats', err);
    return null;
  }
}
