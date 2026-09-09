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
import { useResumeTriggers } from "@/lib/live/useResumeTriggers";
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
 * A DECISION THIS COMPONENT DOES NOT MAKE. The phone layout picks it from the
 * source's shape — 'cover' for a portrait broadcast, which is nearly the
 * phone's own shape, and 'contain' for a landscape one, whose sides cannot be
 * cut without taking a creator's face with them — and the ⛶ button in its top
 * bar overrides that either way. See LiveViewerMobile, which is where both
 * rules live, and `onSourceOrientation`, which is what this player contributes
 * to them.
 *
 * Kept out of here on purpose: three different players can be mounted in that
 * layout, and a fit each of them derived for itself is a picture that changes
 * size when WHEP hands a viewer to HLS.
 */
export type PlayerFit = "cover" | "contain";

/**
 * How stale the picture may be before this player is called unhealthy.
 *
 * Only read on a resume — see `isHealthy`. useVideoFrameWatchdog keeps its own,
 * far more patient ten-second threshold for a foreground stall, where a stream
 * genuinely can be rebuffering rather than dead.
 */
const HLS_STALE_MS = 4_000;

/**
 * How long a resumed player is given to come back on its own before it is
 * thrown away.
 *
 * A suspended media element frequently DOES resume by itself once the tab is
 * foregrounded and given a `seekToLive` to chew on, and that is by far the
 * cheapest possible fix: nothing is rebuilt, nothing is re-buffered, and the
 * viewer sees a stutter rather than a black screen. Rebuilding at once would
 * throw that away every time. Eight hundred milliseconds is enough for the
 * element to present a frame and short enough that a viewer reads it as the
 * picture coming back rather than as a wait.
 */
const RESUME_SETTLE_MS = 800;

/**
 * The minimum gap between two automatic restarts. See requestRestart.
 *
 * Three seconds covers the whole burst a returning phone produces — the resume
 * settle, useWakeRecheck's 1.5s recheck and the frame watchdog's next tick —
 * without being long enough to swallow a second, genuinely new failure.
 */
const RESTART_DEBOUNCE_MS = 3_000;

/**
 * Which way round the SOURCE is — not which way round the player is.
 *
 * Declared here, beside PlayerFit, because the two are the question and the
 * answer: a player REPORTS this upward and is told a fit back, and the rule
 * connecting them lives in the phone layout (see LiveViewerMobile) so that all
 * three players stay interchangeable from the layout's point of view. A player
 * that decided its own fit would make the picture jump the moment WHEP gave
 * way to HLS.
 */
export type SourceOrientation = "landscape" | "portrait";

/**
 * Report a <video> element's source shape, whenever it is known or changes.
 *
 * `loadedmetadata` and the element's own `resize` event are what fire when the
 * DECODED size changes — a creator rotating their phone mid-broadcast, or a
 * WHEP stream renegotiating — and a ResizeObserver on the element catches the
 * case where a layout change is what made the shape matter. Deduped by the
 * caller, so dragging a window edge does not re-report sixty times a second.
 *
 * Returns a disposer. Shared by the three players so that the rule they feed is
 * fed identically, whichever one happens to be mounted.
 */
export function watchSourceOrientation(
  video: HTMLVideoElement,
  report: (orientation: SourceOrientation) => void,
): () => void {
  let last: SourceOrientation | null = null;

  const read = () => {
    const { videoWidth, videoHeight } = video;
    // Zero until the first frame is decoded, and a 0/0 ratio is not an
    // orientation — reporting one would pin the layout to a guess.
    if (!videoWidth || !videoHeight) return;
    const orientation: SourceOrientation =
      videoWidth > videoHeight ? "landscape" : "portrait";
    if (last === orientation) return;
    last = orientation;
    report(orientation);
  };

  video.addEventListener("loadedmetadata", read);
  video.addEventListener("resize", read);
  const observer =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(read) : null;
  observer?.observe(video);
  // Metadata may already be in by the time this runs — a player that attached
  // late (the ladder's rebuild rung, a LiveKit track subscribe) would otherwise
  // wait for a rotation that never comes.
  read();

  return () => {
    video.removeEventListener("loadedmetadata", read);
    video.removeEventListener("resize", read);
    observer?.disconnect();
  };
}

/**
 * Exported so the origin router can be a literal drop-in for this player —
 * see OriginLivePlayer, which takes exactly these props and forwards them
 * untouched on the fallback path. A type export only; nothing about this
 * component's behaviour changes.
 */
export interface HlsLivePlayerProps {
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
   * Off once the broadcast is over.
   *
   * A finished live has nothing to reconnect TO, and a ladder left running
   * against one would escalate all the way to reloading the page of a viewer
   * who is reading the "ไลฟ์จบแล้ว" card.
   */
  recoveryEnabled?: boolean;
  /**
   * The source's shape, whenever it is known or changes.
   *
   * The phone layout turns it into a fit — see LiveViewerMobile. Every viewer
   * player takes the same callback, because any of the three can be the one
   * mounted and a rule fed by only some of them fails silently, as a landscape
   * broadcast shown cropped.
   */
  onSourceOrientation?: (orientation: SourceOrientation) => void;
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
  recoveryEnabled = true,
  onSourceOrientation,
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
   * Tell the layout what shape the source is.
   *
   * Keyed on the ladder's rebuildKey because that rung REPLACES the <video>
   * element: listeners bound to the old one would go with it, and the layout
   * would keep whatever fit the last element reported forever.
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
    return watchSourceOrientation(video, (orientation) =>
      onSourceOrientationRef.current?.(orientation),
    );
  }, [ladder.rebuildKey]);

  /**
   * The picture's own clock.
   *
   * `currentTime` sampled once a second, so that "has this stream moved
   * recently" can be asked from a resume handler without waiting out
   * useVideoFrameWatchdog's ten-second stall threshold. Same signal, different
   * question: the watchdog decides when a foreground player has died, this
   * decides whether a player that has just been handed back is worth keeping.
   */
  const lastProgressAtRef = useRef(0);
  const lastTimeRef = useRef(-1);
  useEffect(() => {
    lastProgressAtRef.current = Date.now();
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused || video.readyState < 2) {
        lastProgressAtRef.current = Date.now();
        return;
      }
      if (video.currentTime !== lastTimeRef.current) {
        lastTimeRef.current = video.currentTime;
        lastProgressAtRef.current = Date.now();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  /**
   * Is this player actually delivering?
   *
   * The transport's own opinion (`phase === 'playing'`) plus the element's
   * (not paused, has data) plus the picture's (currentTime moved inside
   * HLS_STALE_MS). The third is what a suspended tab fails: hls.js comes back
   * from the background believing it is playing, with a <video> that has not
   * advanced a frame since the page was hidden.
   *
   * A DELIBERATELY PAUSED VIDEO IS HEALTHY, as everywhere else in this stack —
   * the framed player has native controls and a viewer is allowed to use them.
   */
  const isHealthy = useCallback((): boolean => {
    const video = videoRef.current;
    if (!video || phase !== "playing" || stalled) return false;
    if (video.paused) return true;
    if (video.readyState < 2) return false;
    return Date.now() - lastProgressAtRef.current < HLS_STALE_MS;
  }, [phase, stalled]);

  /**
   * The one door every automatic restart goes through, and the one place the
   * "never stack a rebuild" rule is written down.
   *
   * There are now three detectors that can decide this player is broken — the
   * frame watchdog, useWakeRecheck's 20-second absence check, and the resume
   * triggers — and on a phone returning from the background all three are
   * looking at the same corpse. Left to themselves they would call restartNow
   * three times inside two seconds, which is three players fighting for one
   * element and a black screen that only reproduces on the fix.
   */
  const lastRestartAtRef = useRef(0);
  const requestRestart = useCallback(
    (
      reason: "wake" | "watchdog",
      detail: Record<string, unknown>,
      options?: { rebuild?: boolean },
    ) => {
      const sinceMs = Date.now() - lastRestartAtRef.current;
      if (sinceMs < RESTART_DEBOUNCE_MS) {
        console.info("[hls] restart already in flight; ignoring", { reason, since_ms: sinceMs });
        return;
      }
      lastRestartAtRef.current = Date.now();
      console.info("[hls] restarting playback", { reason, ...detail, ...options });
      ladder.restartNow(reason, detail, options);
    },
    [ladder],
  );

  /**
   * The picture froze while everything claimed to be fine.
   *
   * Marking it stalled is what turns `health` unhealthy and starts the clock;
   * the restart re-attaches immediately rather than waiting for the first rung,
   * because a frozen picture is not a connect that might still be in progress.
   */
  const handleStall = useCallback(
    (detail: Record<string, unknown>) => {
      setStalled(true);
      requestRestart("watchdog", detail);
    },
    [requestRestart],
  );

  useVideoFrameWatchdog({
    getVideo: useCallback(() => videoRef.current, []),
    active: recoveryEnabled && phase === "playing",
    onStall: handleStall,
  });

  /**
   * Coming back to a suspended player — the HLS half of PR #67.
   *
   * The viewer who folded their phone on the WHEP path and was handed here is
   * looking at exactly the same problem one layer up: hls.js kept its instance
   * and its buffer through the background, iOS suspended the media element, and
   * the element does not restart itself. PR #52's ladder would eventually reach
   * the rung that fixes it — replacing the <video> — twenty seconds later. A
   * resume is a strong enough signal to go there directly.
   *
   * SEEK FIRST, REBUILD ONLY IF THAT WAS NOT ENOUGH. Jumping to the live edge
   * is both the cheap fix for the common case (a stream that resumed twenty
   * minutes behind, which is where this player already sent `seekToLive`) and a
   * nudge that often wakes a merely-stalled element. The settle window below is
   * what gives it the chance to work before anything is thrown away.
   */
  useResumeTriggers({
    enabled: recoveryEnabled,
    onResume: useCallback(
      (event) => {
        const detail = {
          trigger: event.trigger,
          hidden_ms: event.hiddenMs,
          persisted: event.persisted,
        };
        // Always: a live stream that resumed where it stopped is a live stream
        // showing the past, whether or not anything is broken.
        handleRef.current?.seekToLive();

        if (isHealthy()) {
          console.info("[hls] resume; player is healthy", detail);
          return;
        }
        console.info("[hls] resume; player is not healthy, settling", detail);
        window.setTimeout(() => {
          if (isHealthy()) {
            console.info("[hls] resume; recovered on its own", detail);
            return;
          }
          requestRestart("wake", detail, { rebuild: true });
        }, RESUME_SETTLE_MS);
      },
      [isHealthy, requestRestart],
    ),
  });

  /**
   * The slow backstop, kept.
   *
   * It watches the same two doors with a twenty-second absence threshold, and
   * it stays because it catches the case the resume path cannot: a page that
   * came back healthy, settled, and only fell over a second later. Both of them
   * go through requestRestart, which is what stops them rebuilding twice.
   */
  useWakeRecheck({
    enabled: recoveryEnabled,
    isHealthy,
    onWake: useCallback(
      (detail: Record<string, unknown>) => requestRestart("wake", detail, { rebuild: true }),
      [requestRestart],
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

  /*
   * Coming back from a backgrounded tab used to be its own visibilitychange
   * listener here, calling seekToLive — a live stream that resumed where it
   * stopped is a live stream showing the past. That is now the first thing the
   * resume handler above does, on all four doors instead of one, and the
   * listener it replaced has been removed rather than left to fire twice.
   */

  const enableAudio = useCallback(async () => {
    await handleRef.current?.unmute();
  }, []);

  /**
   * The tap that used to be a bare `play()`.
   *
   * PREVIOUS BEHAVIOUR: `video.play()`, its rejection swallowed. That is the
   * right and sufficient thing for the state this button was built for — iOS
   * Low Power Mode refusing autoplay on a perfectly good stream — and it does
   * nothing at all for a viewer who has come back to a suspended hls.js
   * instance, which is the state they are far more likely to be in. They tap,
   * the element has nothing to play, and nothing happens.
   *
   * NOW: play first, because that is the cheap fix and because the gesture is
   * only valid inside this handler — calling play() here is what marks the
   * element user-activated for the programmatic play that follows a rebuild.
   * Then, if the player is not actually delivering, rebuild it.
   */
  const handleTapToPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const healthy = isHealthy();
    console.info("[hls] tap-to-play", { healthy, phase, stalled });

    void video
      .play()
      .then(() => setAutoplayRefused(false))
      .catch(() => undefined);

    if (healthy) return;
    handleRef.current?.seekToLive();
    requestRestart("wake", { trigger: "tap" }, { rebuild: true });
  }, [isHealthy, phase, stalled, requestRestart]);

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
        aria-label={`ไลฟ์: ${title}`}
        // Whatever fit the phone layout handed down — see PlayerFit; the
        // source's own dimensions are REPORTED from here and read there. The
        // framed layout stays `contain`, where letterboxing inside a 16:9 box
        // is correct.
        className={`absolute inset-0 h-full w-full ${
          fullBleed && fit === "cover" ? "object-cover" : "object-contain"
        }`}
        // Faces sit in the upper third of a broadcast, so a 16:9 frame cropped
        // to 9:19.5 should keep the top of the shot rather than the middle of
        // it. Only meaningful while cropping.
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
          onClick={handleTapToPlay}
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
