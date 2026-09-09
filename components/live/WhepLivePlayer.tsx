"use client";

/**
 * The viewer's low-latency player: a WHEP subscription in a plain <video>.
 *
 * THE SAME SHELL AS HlsLivePlayer, ON PURPOSE. The container, the <video>, the
 * chips, the tap-to-unmute button and the tap-to-play button are all deliberate
 * copies of that file, because the page around them must not be able to tell
 * which of the two is mounted. LiveWatchView sizes the box, LiveViewerMobile
 * lays its own chrome over it, and both of them do it against a player whose
 * outer element they never inspect. The moment this one is shaped differently
 * is the moment a fallback becomes visible as a layout jump.
 *
 * WHAT IS DIFFERENT INSIDE, and it is nearly everything:
 *
 *  1. NO PLAYLIST. `srcObject` is a live MediaStream, so there is no manifest
 *     to 404, no segment to retry and no live edge to seek to. The whole of
 *     lib/live/hlsPlayer.ts has no analogue here.
 *  2. NO RECOVERY LADDER. PR #52's ladder rebuilds a player that might yet
 *     work; a dead peer connection is not that. This player has exactly one
 *     response to every failure — hand the viewer to HLS via onFailure and stop
 *     — and the ladder then runs on the HLS player, which is where it belongs.
 *     See OriginLivePlayer.
 *  3. NO WAIT STATE. "The creator has not started pushing frames" is a 404 on
 *     the handshake, which is a failure here and a first-class waiting screen
 *     on the HLS player. Falling back is the RIGHT answer to an early viewer:
 *     they get the screen that counts the wait and the retry that notices when
 *     the creator arrives.
 *
 * ONE MOUNT, ONE ATTEMPT. Nothing in this file retries anything. A WebRTC
 * handshake that just failed overwhelmingly fails again — the browser's WebRTC
 * is off, the network eats UDP, the origin is unwell — and a second attempt
 * only delays the fallback that was always going to be the answer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, Volume2 } from "lucide-react";
import { subscribeWhep, WhepError, type WhepSession } from "@/lib/live/whepClient";
import {
  watchSourceOrientation,
  type PlayerFit,
  type PlayerPresentation,
  type SourceOrientation,
} from "./HlsLivePlayer";
import { DurationPill, LiveBadge, ViewerCountPill } from "./LiveStatsBar";

/**
 * Re-exported for the call sites that imported it from here while the letterbox
 * rule was being built. It is declared next to PlayerFit now — see
 * HlsLivePlayer, where the shape a player reports and the fit it is handed back
 * belong together.
 */
export type { SourceOrientation };

/**
 * How long a handshake that SUCCEEDED has to actually produce a picture.
 *
 * A 201 and an answer SDP prove MediaMTX accepted the offer, not that RTP is
 * flowing: a firewall that passes the HTTPS POST and drops the UDP that follows
 * — which is what a corporate network does — leaves a peer connection stuck in
 * `connecting` with no error to catch. Eight seconds is well past a working
 * WHEP join (200-500ms) and still under the point where a viewer decides the
 * product is broken and leaves.
 */
const FIRST_MEDIA_TIMEOUT_MS = 8_000;

/**
 * How long a `disconnected` connection is given to come back on its own.
 *
 * ICE reports `disconnected` for ordinary blips — a phone changing cell, a
 * laptop hopping access points — and recovers from most of them without help.
 * Failing instantly would drop a viewer to HLS over a two-second wobble and
 * cost them the latency for the rest of the broadcast, since the swap is
 * one-way. `failed` is not given this grace: it is terminal by definition, and
 * with no ICE restart on this path (see whepClient.ts) there is nothing to
 * wait for.
 */
const DISCONNECTED_GRACE_MS = 6_000;

export interface WhepLivePlayerProps {
  /** The WHEP endpoint, from whepEndpointFromHlsPlaybackUrl. */
  whepUrl: string;
  title: string;
  elapsedSeconds: number;
  viewerCount: number;
  /** Rendered over the video — the floating reactions and the reaction rail. */
  overlay?: React.ReactNode;
  presentation?: PlayerPresentation;
  /** Full-bleed only. Defaults to 'cover' — see PlayerFit. */
  fit?: PlayerFit;
  /**
   * Off once the broadcast is over.
   *
   * A finished live drops its peer connection, which is not a fault and must
   * not be reported as one: falling back would mount an HLS player against a
   * playlist that has stopped growing, behind the "ไลฟ์จบแล้ว" card the parent
   * is already showing.
   */
  recoveryEnabled?: boolean;
  /**
   * The one exit from this player. Called at most once per mount, with a
   * machine-readable reason for the console.
   */
  onFailure: (reason: string) => void;
  /**
   * The source's shape, whenever it is known or changes.
   *
   * The letterbox rule depends on this firing whichever player is mounted — a
   * viewer dropped from WHEP to HLS mid-broadcast must not have the picture
   * change shape under them — so all three players take it and the phone layout
   * reads it. See LiveViewerMobile.
   */
  onSourceOrientation?: (orientation: SourceOrientation) => void;
}

export function WhepLivePlayer({
  whepUrl,
  title,
  elapsedSeconds,
  viewerCount,
  overlay,
  presentation = "framed",
  fit = "cover",
  recoveryEnabled = true,
  onFailure,
  onSourceOrientation,
}: WhepLivePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fullBleed = presentation === "fullbleed";

  const [playing, setPlaying] = useState(false);
  /**
   * The same fact as `playing`, readable from a timer.
   *
   * The first-media deadline below is armed once and fires eight seconds later
   * whatever has happened since; state captured when the effect ran would still
   * say false, and a working stream would be dropped to HLS mid-picture.
   */
  const playingRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  /** The browser refused even muted autoplay — iOS Low Power Mode, mainly. */
  const [autoplayRefused, setAutoplayRefused] = useState(false);

  /**
   * The fallback is one-way and fires once.
   *
   * A failing peer connection produces several signals in quick succession —
   * `disconnected`, then `failed`, then the media deadline — and every one of
   * them is the same instruction. A ref rather than state because the guard has
   * to hold between two events in the same tick, which a re-render does not.
   */
  const failedRef = useRef(false);
  const onFailureRef = useRef(onFailure);
  useEffect(() => {
    onFailureRef.current = onFailure;
  }, [onFailure]);

  /**
   * Whether a dropped connection is worth reporting. Read from a ref inside the
   * subscription effect so that ending the broadcast does not tear down and
   * rebuild a working WHEP session.
   */
  const recoveryEnabledRef = useRef(recoveryEnabled);
  useEffect(() => {
    recoveryEnabledRef.current = recoveryEnabled;
  }, [recoveryEnabled]);

  const fail = useCallback((reason: string) => {
    if (failedRef.current) return;
    failedRef.current = true;
    console.warn("[whep] giving up; falling back to HLS", { reason });
    onFailureRef.current(reason);
  }, []);

  /**
   * The subscription itself: one handshake, for the life of this mount.
   *
   * Keyed on `whepUrl` alone. Nothing else in this component's props can
   * invalidate a peer connection, and re-running on anything that changes every
   * second (the elapsed clock, the viewer count) would rebuild the stream under
   * the viewer once a second.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const abort = new AbortController();
    let session: WhepSession | null = null;
    let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    /**
     * The deadline for a picture, armed before the handshake rather than after
     * it. A POST that hangs until its own 10s timeout is just as black a screen
     * as a stream that never arrives, and the viewer should not wait out both.
     */
    const mediaTimer = setTimeout(() => {
      if (cancelled || playingRef.current) return;
      fail("no_media");
    }, FIRST_MEDIA_TIMEOUT_MS);

    const connect = async () => {
      try {
        const active = await subscribeWhep({
          endpoint: whepUrl,
          signal: abort.signal,
          onStream: (stream) => {
            if (cancelled) return;
            video.srcObject = stream;
            /**
             * Muted first, always. Mobile browsers refuse sound without a
             * gesture and reject the play() outright, which on a WebRTC element
             * is a black screen rather than a paused poster. The viewer gets
             * one tap to turn audio on — the same bargain HlsLivePlayer makes,
             * for the same 70%-on-a-phone audience.
             */
            video.muted = true;
            void video
              .play()
              .then(() => setAudioBlocked(true))
              .catch((err) => {
                console.warn("[whep] autoplay refused", err);
                setAutoplayRefused(true);
              });
          },
        });

        if (cancelled) {
          active.close();
          return;
        }
        session = active;

        /**
         * The connection's own verdict, which is the only failure signal that
         * arrives AFTER a successful handshake. Everything before it throws.
         */
        active.pc.addEventListener("connectionstatechange", () => {
          const state = active.pc.connectionState;
          console.info("[whep] connection state", { state });

          if (state === "connected") {
            if (disconnectedTimer) {
              clearTimeout(disconnectedTimer);
              disconnectedTimer = null;
            }
            return;
          }

          // A broadcast that has ended drops its connection as a matter of
          // course. The parent is already showing the ended card over us.
          if (!recoveryEnabledRef.current) return;

          if (state === "failed") {
            fail("connection_failed");
            return;
          }

          if (state === "disconnected" && !disconnectedTimer) {
            disconnectedTimer = setTimeout(() => {
              if (active.pc.connectionState !== "connected") fail("disconnected");
            }, DISCONNECTED_GRACE_MS);
          }
        });
      } catch (err) {
        if (cancelled) return;
        fail(err instanceof WhepError ? err.code : "handshake_error");
      }
    };

    void connect();

    return () => {
      cancelled = true;
      clearTimeout(mediaTimer);
      if (disconnectedTimer) clearTimeout(disconnectedTimer);
      // Aborts a handshake still in flight; closes one that completed. Not
      // optional either way: a peer connection left open holds a decoder and
      // keeps MediaMTX sending RTP to a tab that has gone.
      abort.abort();
      session?.close();
      // The element captured when the effect ran, not videoRef.current: this
      // cleanup can run after React has already detached the ref.
      video.srcObject = null;
    };
  }, [whepUrl, fail]);

  /**
   * Frames are arriving. This is the moment the fallback stops being possible,
   * and it is read from the element rather than the peer connection because a
   * `connected` connection with a stalled decoder is still a black screen.
   */
  const handlePlaying = useCallback(() => {
    playingRef.current = true;
    setPlaying(true);
    setPaused(false);
    setAutoplayRefused(false);
    console.info("[whep] playing");
  }, []);

  /**
   * The source's shape, from the element's intrinsic dimensions.
   *
   * The same watcher the HLS player uses, deliberately: a viewer handed from
   * WHEP to HLS mid-broadcast must be told the same shape by both, or the
   * fallback would show up as the picture changing size.
   *
   * The callback is read through a ref so a parent passing an inline function
   * cannot re-bind these listeners on every render.
   */
  const onSourceOrientationRef = useRef(onSourceOrientation);
  useEffect(() => {
    onSourceOrientationRef.current = onSourceOrientation;
  }, [onSourceOrientation]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return watchSourceOrientation(video, (orientation) => {
      console.info("[whep] source orientation", { orientation });
      onSourceOrientationRef.current?.(orientation);
    });
  }, []);

  const enableAudio = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    void video.play().catch(() => undefined);
    setAudioBlocked(false);
  }, []);

  // Deliberately identical to HlsLivePlayer's container — see the file header.
  return (
    <div
      className={
        fullBleed
          ? "fixed inset-0 z-0 h-[100dvh] w-screen overflow-hidden bg-black"
          : "relative min-h-0 flex-1 overflow-hidden bg-black lg:rounded-2xl lg:border lg:border-white/10"
      }
    >
      <video
        ref={videoRef}
        playsInline
        autoPlay
        // Controls for the same reason the HLS player has them: this is a
        // <video> the viewer owns, and it is the way back after a browser
        // refuses autoplay. Off in full-bleed, where the control bar would land
        // on the chat input row.
        controls={!fullBleed}
        onPlaying={handlePlaying}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        aria-label={`ไลฟ์: ${title}`}
        // Whatever fit the phone layout handed down — see PlayerFit.
        className={`absolute inset-0 h-full w-full ${
          fullBleed && fit === "cover" ? "object-cover" : "object-contain"
        }`}
        // Faces sit in the upper third of a broadcast, so a portrait frame
        // cropped to 9:19.5 should keep the top of the shot, not the middle.
        // Only meaningful while cropping.
        style={
          fullBleed && fit === "cover" ? { objectPosition: "50% 30%" } : undefined
        }
      />

      {/* The page's own top bar carries the same three numbers in full-bleed,
          laid out against the safe areas — see LiveViewerMobile. */}
      {!fullBleed && (
        <>
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[70%] items-center gap-2">
            <LiveBadge pulse={playing} />
            <span className="truncate rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm">
              {title}
            </span>
          </div>

          <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2">
            <ViewerCountPill count={viewerCount} />
            <DurationPill seconds={elapsedSeconds} />
          </div>
        </>
      )}

      {overlay}

      {audioBlocked && playing && (
        <button
          type="button"
          onClick={enableAudio}
          className={`absolute left-1/2 z-20 inline-flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
            fullBleed ? "top-[38%]" : "bottom-20"
          }`}
        >
          <Volume2 size={16} aria-hidden />
          แตะเพื่อเปิดเสียง
        </button>
      )}

      {fullBleed && (autoplayRefused || (paused && playing)) && (
        <button
          type="button"
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            void video
              .play()
              .then(() => setAutoplayRefused(false))
              .catch(() => undefined);
          }}
          className="absolute left-1/2 top-1/2 z-20 inline-flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md transition hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <Play size={26} aria-hidden />
          <span className="sr-only">เล่นไลฟ์</span>
        </button>
      )}

      {/*
        One spinner, no counter and no retry button — unlike the HLS player's
        overlay, which has all three. Nothing here is worth waiting out: this
        state lasts at most FIRST_MEDIA_TIMEOUT_MS and then becomes the HLS
        player, whose overlay is the one that explains a long wait and offers
        the way out of it.
      */}
      {!playing && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/70 px-6 text-center">
          <div>
            <Loader2 size={28} className="mx-auto animate-spin text-cyan-300" aria-hidden />
            <p className="mt-3 text-sm text-white/80" role="status">
              กำลังโหลดไลฟ์...
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
