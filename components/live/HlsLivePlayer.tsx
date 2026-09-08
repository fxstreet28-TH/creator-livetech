"use client";

/**
 * The viewer's player: a Bunny LL-HLS stream in a plain <video>.
 *
 * This is what replaced the LiveKit room on the watch page, and it is where
 * the entire cost saving lives. A viewer is now an HTTP request to a CDN at
 * $0.005/GB instead of a WebRTC participant at $0.12/GB, which is the
 * difference between 2.26 THB and roughly 0.30 THB per viewer-hour.
 *
 * Three things this has to get right that the LiveKit player never did:
 *
 *  1. THE STREAM MAY NOT EXIST YET. The row says 'live' from the moment the
 *     egress starts, and Bunny needs a few seconds of RTMP before it writes a
 *     playlist. A 404 on the manifest is 'waiting', not an error — the retry
 *     lives in lib/live/hlsPlayer.ts.
 *  2. AUTOPLAY. Mobile browsers refuse sound without a gesture, so playback
 *     starts muted and the viewer gets one tap to turn audio on. Starting
 *     unmuted and hoping shows a stopped video to most of this audience, and
 *     70% of it is on a phone.
 *  3. THE URL EXPIRES. Playback URLs are minted with a one-hour TTL and a
 *     60-minute broadcast is an explicit requirement, so the parent refreshes
 *     the URL and this component re-attaches when it changes.
 *
 * The reaction overlay and rail sit on top, exactly as before, but they are
 * fed by the Supabase Realtime channel rather than by the video transport —
 * this component knows nothing about either.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, Volume2, WifiOff } from "lucide-react";
import {
  MANIFEST_RETRY_BUDGET_MS,
  attachHlsStream,
  type HlsFailureReason,
  type HlsHandle,
  type HlsPhase,
} from "@/lib/live/hlsPlayer";
import {
  useRecoveryLadder,
  type PlaybackHealth,
} from "@/lib/live/useRecoveryLadder";
import type { HlsSource } from "@/lib/live/viewerDiagnostics";
import { useStaleBuildGuard } from "@/lib/live/useStaleBuildGuard";
import { useVideoFrameWatchdog } from "@/lib/live/useVideoFrameWatchdog";
import { useWakeRecheck } from "@/lib/live/useWakeRecheck";
import type { LatencyMode } from "@/lib/live/types";
import { LiveRecoveryOverlay } from "./LiveRecoveryOverlay";
import { DurationPill, LiveBadge, ViewerCountPill } from "./LiveStatsBar";

/**
 * How the player is dressed, not what it plays.
 *
 * 'framed' is the original and the default: a 16:9 box in the page's grid,
 * with the LIVE / viewer / duration chips painted in its corners and the
 * browser's own controls along the bottom.
 *
 * 'fullbleed' is the phone watch layout. The video fills the viewport and
 * everything a viewer touches — the top bar, the reaction rail, the chat and
 * the input row — is a translucent layer the PAGE owns and positions against
 * the safe areas. So the player stops drawing chips (the page's top bar has
 * the same three numbers, laid out for a thumb) and stops drawing controls
 * (they would sit exactly where the input row is). See LiveViewerMobile.
 */
export type PlayerPresentation = "framed" | "fullbleed";

/**
 * How a full-bleed video fills the screen. Nothing else reads it.
 *
 * 'cover' fills the phone and CROPS whatever does not fit — correct for a
 * portrait source, which is what a mobile broadcaster publishes, and where
 * `object-position: 50% 30%` keeps the face rather than the middle.
 *
 * 'contain' draws the whole frame inside the screen and letterboxes the
 * difference — correct for a LANDSCAPE source, because a 16:9 desktop
 * broadcast cropped to 9:19.5 loses about two thirds of its width, and a
 * creator sits where their camera is aimed: in the part that gets cut.
 * Facebook Live and YouTube Live have shown landscape broadcasts to portrait
 * viewers this way for years; black bars are a smaller loss than the face.
 *
 * NEITHER IS A DEFAULT. The player does not choose — it reports the source's
 * shape (see SourceOrientation) and the phone layout resolves that, plus the
 * viewer's own ⛶ override, into this. See LiveViewerMobile.
 */
export type PlayerFit = "cover" | "contain";

/**
 * Which way round the source's own frames are.
 *
 * Read from the element, because nothing in a playlist or a track's metadata
 * says which way up the camera was: a creator on a desktop publishes 16:9 and
 * a creator on a phone publishes 9:16, down the same pipe, and the publisher
 * is deliberately not asked to change either (see CreatorBroadcaster).
 *
 * 'unknown' is the honest first state — `videoWidth` is 0 until metadata
 * arrives — and it is one a viewer can see, so whoever resolves it has to pick
 * something safe for it. `contain` is that: it never hides part of the frame.
 */
export type SourceOrientation = "unknown" | "landscape" | "portrait";

/** The source's shape as the element currently reports it. */
export function readSourceOrientation(
  video: HTMLVideoElement,
): SourceOrientation {
  const { videoWidth, videoHeight } = video;
  if (videoWidth <= 0 || videoHeight <= 0) return "unknown";
  // Square counts as portrait: it fills a portrait phone with no crop worth
  // the name, and there is nothing to letterbox.
  return videoWidth > videoHeight ? "landscape" : "portrait";
}

interface HlsLivePlayerProps {
  /** For the diagnostics rows the recovery ladder writes. */
  sessionId: string;
  playbackUrl: string;
  /**
   * Which server produced this playlist. Recorded on every recovery-ladder row;
   * the player itself does not branch on it — a playlist is a playlist.
   */
  source: HlsSource;
  latencyMode: LatencyMode;
  title: string;
  elapsedSeconds: number;
  viewerCount: number;
  /** Rendered over the video — the floating reactions and the reaction rail. */
  overlay?: React.ReactNode;
  presentation?: PlayerPresentation;
  /** Full-bleed only. Defaults to 'cover' — see PlayerFit. */
  fit?: PlayerFit;
  /**
   * The source's shape, whenever the element settles on a new one.
   *
   * Fired on `loadedmetadata` and on the element's own `resize` — once per
   * settled state, never polled — and only with a shape that is actually
   * known. The phone layout is the only caller; it is what turns this into a
   * PlayerFit. Nothing here branches on it.
   */
  onSourceOrientation?: (orientation: SourceOrientation) => void;
  /**
   * Off once the broadcast is over.
   *
   * A finished live has nothing to reconnect TO, and a ladder left running
   * against one would escalate all the way to reloading the page of a viewer
   * who is reading the "ไลฟ์จบแล้ว" card.
   */
  recoveryEnabled?: boolean;
}

export function HlsLivePlayer({
  sessionId,
  playbackUrl,
  source,
  latencyMode,
  title,
  elapsedSeconds,
  viewerCount,
  overlay,
  presentation = "framed",
  fit = "cover",
  onSourceOrientation,
  recoveryEnabled = true,
}: HlsLivePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handleRef = useRef<HlsHandle | null>(null);
  const fullBleed = presentation === "fullbleed";

  const [phase, setPhase] = useState<HlsPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  /**
   * Whether the element is currently paused.
   *
   * Only rendered against in full-bleed, which has no native controls: it is
   * what puts a play button back on the screen when a browser refused even
   * muted autoplay. Tracked from the element's own events rather than read on
   * demand, because `video.paused` is not something React re-renders for.
   */
  const [paused, setPaused] = useState(false);
  /**
   * When the current wait began, and a tick to re-render against it.
   *
   * The elapsed time is DERIVED from the start rather than accumulated in
   * state: a counter incremented from an effect is a cascading render every
   * second, and it drifts whenever the tab is throttled in the background —
   * which is exactly when a viewer is most likely to be waiting.
   *
   * Shown at all because an indefinite spinner tells a viewer nothing: they
   * cannot tell "the creator is 5 seconds away" from "this will never work",
   * so they either leave too early or stare at it too long. A counter against
   * a stated ceiling answers both.
   */
  const waitStartedAtRef = useRef<number | null>(null);
  const [waitingSeconds, setWaitingSeconds] = useState(0);

  /**
   * WHY there is no picture, which is a different question from whether there
   * is one — see HlsFailureReason.
   *
   * A missing manifest means the creator has not started pushing frames, and
   * the recovery ladder must sit still through it: escalating would reload the
   * page of every viewer who arrived early, and the reload would fix nothing
   * because nothing here is broken.
   */
  const [failureReason, setFailureReason] = useState<HlsFailureReason | null>(
    null,
  );

  /** True between the watchdog spotting a frozen picture and frames resuming. */
  const [stalled, setStalled] = useState(false);
  /**
   * The browser refused to play even muted — iOS Low Power Mode, mainly.
   *
   * NOT a fault, and the distinction is load-bearing. The stream is fine and
   * the browser is deliberately not advancing it; what that needs is a tap. On
   * the native Safari path the phase never reaches 'playing' in this state, so
   * without this flag the ladder would read a healthy stream as a dead one and
   * reload the page of every iOS viewer in Low Power Mode, on a timer, forever.
   */
  const [autoplayRefused, setAutoplayRefused] = useState(false);

  /**
   * Phase changes come from the player, which is the external system this
   * component is synchronising with — so the wait clock is started and cleared
   * here, in its callback, rather than in an effect watching `phase`.
   */
  const handlePhaseChange = useCallback(
    (next: HlsPhase, reason?: HlsFailureReason) => {
      setFailureReason(next === "playing" ? null : (reason ?? null));
      if (next === "playing") setStalled(false);
      if (next === "waiting") {
        // Only on entering the wait: a stream that stalls, recovers and stalls
        // again should count from the start of the CURRENT wait, and the retry
        // loop reports 'waiting' repeatedly while one wait is still running.
        waitStartedAtRef.current ??= Date.now();
      } else {
        waitStartedAtRef.current = null;
        setWaitingSeconds(0);
      }
      setPhase(next);
    },
    [],
  );

  /**
   * A browser that cannot play HLS at all.
   *
   * The one failure no amount of retrying touches, so the ladder is switched
   * off for it and the original message — which names the actual remedy,
   * trying a different browser — is shown instead of a card offering to try
   * again.
   */
  const unrecoverable = failureReason === "unsupported";

  /**
   * What the ladder is told about us.
   *
   * 'paused' for a missing manifest is the whole of the early-viewer
   * protection: the creator has not started pushing frames, nothing on this
   * device is broken, and escalating would reload the page of everyone who
   * arrived a few seconds early. Every other reason — a refused playlist, a
   * network fault, a decoder that will not take the bytes, or simply never
   * reaching 'playing' — is this device's problem to fix.
   */
  const health: PlaybackHealth =
    failureReason === "manifest_missing"
      ? "paused"
      : // A browser that will not autoplay is not a broken one — see the flag.
        autoplayRefused
        ? "healthy"
        : phase === "playing" && !stalled
          ? "healthy"
          : "unhealthy";

  const ladder = useRecoveryLadder({
    source,
    sessionId,
    delivery: "hls",
    health,
    enabled: recoveryEnabled && !unrecoverable,
  });

  /**
   * The HLS analogue of the ladder's 'relay' rung.
   *
   * There is no ICE here to route around, but there is the same trade: the
   * conservative profile buffers four segments back instead of chasing the
   * live edge, which is what survives a connection that cannot hold it. A
   * viewer two seconds further behind is a viewer who is watching.
   */
  const effectiveLatencyMode: LatencyMode =
    ladder.step === "normal" ? latencyMode : "standard";

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setError(null);

    const handle = attachHlsStream({
      video,
      playbackUrl,
      latencyMode: effectiveLatencyMode,
      onPhaseChange: handlePhaseChange,
      onError: setError,
      onAudioBlocked: setAudioBlocked,
      onAutoplayRefused: setAutoplayRefused,
    });
    handleRef.current = handle;

    return () => {
      handleRef.current = null;
      // Not optional. hls.js keeps timers, a MediaSource and in-flight segment
      // requests alive; an undestroyed instance keeps pulling — and billing —
      // bandwidth after the component has gone.
      handle.destroy();
    };
    // attemptKey is what makes every rung of the ladder actually happen: each
    // escalation throws this player away and builds a new one.
  }, [playbackUrl, effectiveLatencyMode, handlePhaseChange, ladder.attemptKey]);

  /**
   * The picture froze while everything claimed to be fine.
   *
   * Marking it stalled is what turns `health` unhealthy and starts the clock;
   * restartNow re-attaches immediately rather than waiting for the first rung,
   * because a frozen picture is not a connect that might still be in progress.
   */
  const handleStall = useCallback(
    (detail: Record<string, unknown>) => {
      setStalled(true);
      ladder.restartNow("watchdog", detail);
    },
    [ladder],
  );

  useVideoFrameWatchdog({
    getVideo: useCallback(() => videoRef.current, []),
    active: recoveryEnabled && phase === "playing",
    onStall: handleStall,
  });

  useWakeRecheck({
    enabled: recoveryEnabled,
    isHealthy: useCallback(() => {
      const video = videoRef.current;
      return (
        phase === "playing" &&
        !stalled &&
        !!video &&
        !video.paused &&
        video.readyState >= 2
      );
    }, [phase, stalled]),
    onWake: useCallback(
      (detail: Record<string, unknown>) => ladder.restartNow("wake", detail),
      [ladder],
    ),
  });

  useStaleBuildGuard({
    sessionId,
    delivery: "hls",
    source,
    // A first escalation IS a connect failure, and it is the moment the answer
    // matters — a stale bundle is the one cause the ladder itself cannot fix.
    connectFailed: phase === "error" || ladder.step !== "normal",
    enabled: recoveryEnabled,
  });

  /**
   * Recomputed from the start time on every tick rather than incremented.
   *
   * A `+ 1` per second silently under-counts whenever the browser throttles
   * background timers — which is precisely the tab a viewer leaves open while
   * waiting for a creator to appear.
   */
  useEffect(() => {
    if (phase !== "waiting") return;
    const timer = setInterval(() => {
      const startedAt = waitStartedAtRef.current;
      if (startedAt !== null)
        setWaitingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  /**
   * Coming back from a backgrounded tab.
   *
   * A paused live stream resumes wherever it stopped, which on a 20-minute
   * detour is 20 minutes behind. Jumping to the live edge is what a viewer
   * means by "live", and it is the difference between a working stream and one
   * where the chat is discussing something that has not happened yet.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible")
        handleRef.current?.seekToLive();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const enableAudio = useCallback(async () => {
    await handleRef.current?.unmute();
  }, []);

  /**
   * Tell the parent what shape the source turned out to be.
   *
   * Both the events it is bound to fire once per settled state — metadata
   * arriving, and the stream changing resolution mid-broadcast, which is what
   * a creator rotating their phone looks like from here. An 'unknown' reading
   * is swallowed rather than reported: it would only overwrite a shape that is
   * already correct with one nobody can act on.
   */
  const reportSourceOrientation = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      const orientation = readSourceOrientation(event.currentTarget);
      if (orientation !== "unknown") onSourceOrientation?.(orientation);
    },
    [onSourceOrientation],
  );

  // Square and borderless on a phone, where the player is edge-to-edge and a
  // rounded border would just be a hairline of page colour around the video.
  // Rounded again from lg, where it sits inside the padded grid.
  //
  // FULL-BLEED IS THE VIEWPORT, STATED OUTRIGHT. `fixed inset-0` with an
  // explicit 100vw × 100dvh rather than `absolute inset-0`: an absolute box is
  // only ever as big as whatever ancestor happens to be its containing block,
  // so a wrapper that picked up a height from its content — or an
  // `aspect-ratio` anywhere above it — silently became the video's box. There
  // is no ratio, no max-height and no intrinsic sizing anywhere in this chain
  // now; the element is the screen. z-0 keeps it under the page's chrome,
  // which is z-20 (see LiveViewerMobile.module.css).
  return (
    <div
      className={
        fullBleed
          ? "fixed inset-0 z-0 h-[100dvh] w-screen overflow-hidden bg-black"
          : "relative min-h-0 flex-1 overflow-hidden bg-black lg:rounded-2xl lg:border lg:border-white/10"
      }
    >
      <video
        /*
          Replaced outright on the 'rebuild' rung — a NEW element, not a
          re-attached one. That is the point of that rung: a decoder wedged
          inside this element cannot be argued with, only discarded, and this
          is the cheapest way to say so in React. Keyed off rebuildKey rather
          than attemptKey so the earlier, cheaper rungs keep whatever the
          browser has already buffered.
        */
        key={ladder.rebuildKey}
        ref={videoRef}
        playsInline
        // Controls are on because this is a <video> the viewer owns — unlike
        // the LiveKit element, which the SDK built and drove. It is also the
        // only way back to playing after a browser refuses even muted
        // autoplay, which iOS Low Power Mode does.
        //
        // Off in full-bleed, where the control bar would land on the chat input
        // row and the scrubber on a live edge is not a control anyway. The
        // "tap to play" button below replaces the one thing it was load-bearing
        // for.
        controls={!fullBleed}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        // Once when the dimensions first arrive, and again if they change —
        // no loop, no polling. `resize` is a media event on <video>, not the
        // window's; React binds it on the element.
        onLoadedMetadata={reportSourceOrientation}
        onResize={reportSourceOrientation}
        aria-label={`ไลฟ์: ${title}`}
        // Whatever the page asked for in full-bleed; the framed layout stays
        // `contain`, where letterboxing inside a 16:9 box is correct. The
        // source's shape is REPORTED from here, not acted on here — see
        // PlayerFit and LiveViewerMobile.
        className={`absolute inset-0 h-full w-full ${
          fullBleed && fit === "cover" ? "object-cover" : "object-contain"
        }`}
        // Faces sit in the upper third of a broadcast, so a portrait frame
        // cropped to 9:19.5 should keep the top of the shot rather than the
        // middle of it. Only meaningful while cropping — `contain` crops
        // nothing, so there is no position to choose.
        style={
          fullBleed && fit === "cover"
            ? { objectPosition: "50% 30%" }
            : undefined
        }
      />

      {/* The page's own top bar carries the same three numbers in full-bleed,
          laid out against the safe areas — see LiveViewerMobile. */}
      {!fullBleed && (
        <>
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[70%] items-center gap-2">
            <LiveBadge pulse={phase === "playing"} />
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

      {audioBlocked && phase === "playing" && (
        <button
          type="button"
          onClick={() => void enableAudio()}
          // Above the reaction rail rather than beside it: on a narrow phone
          // the two would overlap at bottom-centre, and this button is the
          // difference between a silent stream and a working one. In full-bleed
          // it clears the chat column and the input row instead.
          className={`absolute left-1/2 z-20 inline-flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
            fullBleed ? "top-[38%]" : "bottom-20"
          }`}
        >
          <Volume2 size={16} aria-hidden />
          แตะเพื่อเปิดเสียง
        </button>
      )}

      {/*
        The way back in when a browser refused even muted autoplay — iOS Low
        Power Mode, mainly. The framed player leaves this to its native
        controls; full-bleed has none, so a paused video would otherwise be a
        black screen with no affordance on it at all.
      */}
      {fullBleed && (autoplayRefused || (paused && phase === "playing")) && (
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

      {unrecoverable ? (
        <PlayerOverlay
          phase="error"
          error={error}
          waitingSeconds={waitingSeconds}
        />
      ) : phase !== "playing" || stalled || ladder.exhausted ? (
        <LiveRecoveryOverlay
          step={ladder.step}
          secondsToNextStep={ladder.secondsToNextStep}
          exhausted={ladder.exhausted}
          onRetry={ladder.retryNow}
          /*
            The creator-is-not-here copy survives unchanged, because that state
            is not a failure and must not start reading like one. Everything
            else says the same neutral thing whichever rung is running: which
            rung it is cannot be acted on by a viewer, and naming it would make
            a working recovery look like an escalating fault.
          */
          message={
            failureReason === "manifest_missing"
              ? "กำลังรอสัญญาณจาก Creator..."
              : "กำลังเชื่อมต่อวิดีโอ..."
          }
          detail={
            failureReason === "manifest_missing" ? (
              <p className="mt-1 text-xs tabular-nums text-white/40">
                {formatWait(waitingSeconds)} / รอสูงสุด{" "}
                {formatWait(MANIFEST_RETRY_BUDGET_MS / 1000)}
              </p>
            ) : null
          }
        />
      ) : null}
    </div>
  );
}

/** m:ss, for the wait counter. */
function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * What covers the video while it is not playing.
 *
 * 'waiting' gets its own copy and is NOT phrased as a problem: it is the
 * normal state of a viewer who opened the page a few seconds before the
 * creator's frames reached Bunny, and telling them something went wrong would
 * be both wrong and enough to make them leave.
 */
function PlayerOverlay({
  phase,
  error,
  waitingSeconds,
}: {
  phase: HlsPhase;
  error: string | null;
  waitingSeconds: number;
}) {
  if (phase === "error") {
    return (
      <div
        role="alert"
        // Inert: it has nothing to press, and it covers the whole player — on
        // the framed layout that is the browser's own controls, and on the
        // full-bleed one it is the tap that collapses an expanded chat.
        className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/85 px-6 text-center"
      >
        <div>
          <WifiOff size={30} className="mx-auto text-rose-300" aria-hidden />
          <p className="mt-3 text-base font-semibold text-white">
            เข้าชมไลฟ์ไม่สำเร็จ
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-white/55">
            {error ?? "การเชื่อมต่อขาดหาย"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/70 px-6 text-center">
      <div>
        <Loader2
          size={28}
          className="mx-auto animate-spin text-cyan-300"
          aria-hidden
        />
        <p className="mt-3 text-sm text-white/80" role="status">
          {phase === "waiting"
            ? "กำลังรอสัญญาณจาก Creator..."
            : "กำลังโหลดไลฟ์..."}
        </p>
        {phase === "waiting" && (
          <p className="mt-1 text-xs tabular-nums text-white/40">
            {formatWait(waitingSeconds)} / รอสูงสุด{" "}
            {formatWait(MANIFEST_RETRY_BUDGET_MS / 1000)}
          </p>
        )}
      </div>
    </div>
  );
}
