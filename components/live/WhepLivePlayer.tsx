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
 *     work by degrees — a conservative latency profile, then a new element,
 *     then a page reload. None of those rungs mean anything to a subscription:
 *     the only repair a WHEP session has is a NEW WHEP session, which is one
 *     POST and under a second, so this file has one rung and takes it at once.
 *  3. NO WAIT STATE. "The creator has not started pushing frames" is a 404 on
 *     the handshake, which is a failure here and a first-class waiting screen
 *     on the HLS player. Falling back is the RIGHT answer to an early viewer:
 *     they get the screen that counts the wait and the retry that notices when
 *     the creator arrives.
 *
 * WHAT THIS FILE IS FOR, AND WHY IT CHANGED (PR #67).
 *
 * PR #60 shipped "one mount, one attempt": nothing was ever retried, because a
 * WebRTC handshake that just failed overwhelmingly fails again. That is true of
 * the failures it was written against and false of the one that turned out to
 * matter most. iOS Safari CLOSES active peer connections when a page goes to
 * the background — documented, expected, and the single most common thing a
 * real viewer does. A viewer who folded their phone came back to a `closed`
 * connection attached to a <video> that would never show another frame, a
 * fallback that could not save them either (iOS suspends the media element too,
 * and blocks the autoplay that would restart it), and a tap-to-play button that
 * called `play()` on a dead stream and therefore did nothing at all, forever.
 *
 * So this player now has one idea, and it is the idea every live platform ships:
 *
 *   ON EVERY RESUME, ASK WHETHER THE SESSION IS ACTUALLY DELIVERING.
 *   IF IT IS NOT, THROW IT AWAY AND SUBSCRIBE AGAIN FROM SCRATCH.
 *
 * "Delivering" is answered from the picture, not from the transport — see
 * `isHealthy` — because `connected` is precisely the claim that survives a
 * suspension. "Resume" is all four doors a browser opens (see useResumeTriggers)
 * plus the tap on the overlay, which is a resume the VIEWER declared. And
 * "subscribe again" is a whole new handshake rather than a repair: there is
 * nothing in a dead peer connection worth keeping.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, Volume2 } from "lucide-react";
import { subscribeWhep, WhepError, type WhepSession } from "@/lib/live/whepClient";
import { useResumeTriggers, type ResumeTrigger } from "@/lib/live/useResumeTriggers";
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
 * How long the FIRST handshake of a mount has to actually produce a picture.
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
 * The same deadline on a RESUBSCRIBE, and shorter.
 *
 * Six rather than eight because the viewer is already looking at the screen —
 * they just unfolded the phone — and because there are up to three of these in
 * a cycle. Eight seconds each would be twenty-four seconds of black before the
 * HLS fallback was even reached, which is worse than the bug.
 */
const RESUBSCRIBE_MEDIA_TIMEOUT_MS = 6_000;

/**
 * How long a `disconnected` connection is given to come back on its own, while
 * the tab is in the FOREGROUND.
 *
 * ICE reports `disconnected` for ordinary blips — a phone changing cell, a
 * laptop hopping access points — and recovers from most of them without help.
 * Resubscribing instantly would rebuild a session that was about to fix itself.
 * `failed` and `closed` are not given this grace: they are terminal by
 * definition and there is nothing to wait for.
 *
 * NOT APPLIED ON A RESUME. A resume is a strong signal — the OS just handed the
 * page back and the connection is dead because it was suspended, not because a
 * candidate pair wobbled — so that path acts immediately. This grace exists for
 * a tab that never went away.
 */
const DISCONNECTED_GRACE_MS = 6_000;

/**
 * How stale the picture may be before the session is called unhealthy.
 *
 * Read from `video.currentTime` advancing, which is the most portable of the
 * three candidates: `requestVideoFrameCallback` is not on every iOS version
 * this product targets, and `getStats().framesDecoded` costs a promise and a
 * map walk per check for the same answer. On a MediaStream element currentTime
 * advances with the presented media, so "it has not moved in four seconds"
 * means the viewer has been looking at a still frame for four seconds.
 *
 * Four is chosen against the resume, not against the network: a session that
 * survived a background is delivering again within a frame or two, so anything
 * that is still frozen four seconds later is not going to unfreeze.
 */
const HEALTH_STALE_MS = 4_000;

/**
 * The foreground watchdog's threshold, one second slacker than the health one.
 *
 * iOS sometimes suspends the DECODER without changing the peer connection's
 * state — the "live but silent" failure PR #66 had to handle on the capture
 * side, seen from the other end of the wire. The transport says `connected`,
 * bytes are arriving, and the picture is a photograph. No connection state ever
 * reports it, so a cheap timer against the same currentTime signal is the only
 * thing that can.
 */
const FRAME_WATCHDOG_STALE_MS = 5_000;
const FRAME_POLL_MS = 1_000;

/**
 * The bounded ladder that replaced "never retry WHEP".
 *
 * Three handshakes per resume cycle. The first runs the moment the resume is
 * seen; the delays below are taken AFTER a failure, before the next attempt, so
 * a cycle is t=0, t≈0.5s, t≈2.0s and then the viewer is handed to HLS. The 3s
 * entry is the delay that would precede a fourth attempt: it is written down
 * because it is the policy Por specified, and it is only consumed if the
 * ceiling below is raised.
 *
 * WHY BOUNDED AT ALL. A viewer whose network genuinely cannot carry WebRTC
 * would otherwise spend a whole broadcast rebuilding sessions that cannot work
 * while a perfectly good HLS stream sat unwatched. Three is enough to ride out
 * an origin restarting or a wifi handover, and cheap enough (one POST each)
 * that it costs nothing when it does not help.
 */
const WHEP_RESUBSCRIBE_BACKOFF_MS = [500, 1_500, 3_000];
const MAX_RESUBSCRIBE_ATTEMPTS = 3;

/** What set a (re)subscribe going. Only ever logged. */
type SubscribeReason = ResumeTrigger | "mount" | "watchdog" | "connection";

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
   * is already showing. It also stops the resume triggers and the watchdog, so
   * a viewer reading that card does not resubscribe to a dead path every time
   * they switch apps.
   */
  recoveryEnabled?: boolean;
  /**
   * The one exit from this player. Called at most once per mount, with a
   * machine-readable reason — the router classifies it into "WHEP cannot work
   * here" and "WHEP did not work just now". See isStructuralWhepFailure.
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
   * Every deadline in this file is armed once and fires later whatever has
   * happened since; state captured when the timer was set would still say
   * false, and a working stream would be torn down mid-picture.
   */
  const playingRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  /** The browser refused even muted autoplay — iOS after a resume, mainly. */
  const [autoplayRefused, setAutoplayRefused] = useState(false);
  /** A resubscribe is in flight; the spinner says so rather than the picture. */
  const [resubscribing, setResubscribing] = useState(false);

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
   * Whether a dropped connection is worth reacting to. Read from a ref inside
   * the async paths so that ending the broadcast does not race a resubscribe.
   */
  const recoveryEnabledRef = useRef(recoveryEnabled);
  useEffect(() => {
    recoveryEnabledRef.current = recoveryEnabled;
  }, [recoveryEnabled]);

  /** The live session and the handshake that is building one. */
  const sessionRef = useRef<WhepSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Which attempt owns the element.
   *
   * Bumped before every teardown, so a handshake that resolves after its
   * successor started — a slow POST returning during the next resubscribe —
   * recognises itself as stale, closes its own session and touches nothing. A
   * counter rather than a boolean because there can be several in flight over
   * the life of a mount, and each has to be able to tell whether it is the
   * current one.
   */
  const generationRef = useRef(0);
  /** One cycle at a time. A burst of triggers must not stack handshakes. */
  const busyRef = useRef(false);
  /** Torn down for good: the component unmounted, or the fallback fired. */
  const disposedRef = useRef(false);

  /** When the picture last moved. The only honest health signal — see isHealthy. */
  const lastProgressAtRef = useRef(0);
  const lastTimeRef = useRef(-1);

  /**
   * Whether the VIEWER asked for sound, as opposed to whether the element is
   * muted right now.
   *
   * Load-bearing across a resubscribe: a fresh <video> source starts muted by
   * necessity, and a viewer who had turned sound on would otherwise be silently
   * re-muted every time they picked their phone up. The wish is remembered here
   * and re-applied to every new stream; where iOS refuses it, the existing
   * tap-to-unmute chip comes back rather than the wish being forgotten.
   */
  const wantsAudioRef = useRef(false);

  /** The last handshake needed a gesture. Not a failure — see runHandshake. */
  const gestureNeededRef = useRef(false);

  const fail = useCallback((reason: string) => {
    if (failedRef.current) return;
    failedRef.current = true;
    disposedRef.current = true;
    console.warn("[whep] out of resubscribes; handing this cycle to HLS", { reason });
    onFailureRef.current(reason);
  }, []);

  /**
   * Is this session actually delivering a picture?
   *
   * TWO CLAIMS, AND THE SECOND IS THE ONE THAT MATTERS. `connectionState ===
   * 'connected'` is necessary and nowhere near sufficient: a connection
   * suspended by iOS can report `connected` for as long as it takes the browser
   * to notice, and a decoder that stopped never changes the state at all. So
   * the picture is asked directly — has `currentTime` moved in the last
   * HEALTH_STALE_MS.
   *
   * A DELIBERATELY PAUSED VIDEO IS HEALTHY. The framed player has native
   * controls; a viewer who pressed pause produces no frames for an entirely
   * correct reason, and rebuilding their session under them would be a bug
   * wearing a watchdog's clothes. The peer connection is the tell: if it is
   * still connected, nothing is broken and the viewer is in charge.
   */
  const isHealthy = useCallback((): boolean => {
    const video = videoRef.current;
    const pc = sessionRef.current?.pc;
    if (!video || !pc) return false;
    if (pc.connectionState !== "connected") return false;
    if (video.paused) return true;
    if (!playingRef.current) return false;
    return Date.now() - lastProgressAtRef.current < HEALTH_STALE_MS;
  }, []);

  /**
   * Attach a fresh stream and start it, honouring the remembered audio wish.
   *
   * Returns 'playing' when the browser accepted, 'gesture' when it refused —
   * which is NOT a failure of the session and must not spend a rung of the
   * ladder. The session is live and holding frames; it needs a tap, and the
   * overlay that asks for one now means something, because behind it there is a
   * connection that works.
   */
  const attachAndPlay = useCallback(
    async (video: HTMLVideoElement, stream: MediaStream): Promise<"playing" | "gesture"> => {
      video.srcObject = stream;
      video.muted = !wantsAudioRef.current;

      try {
        await video.play();
        setAudioBlocked(!wantsAudioRef.current);
        setAutoplayRefused(false);
        return "playing";
      } catch (err) {
        // Sound was the thing it objected to. Mobile browsers refuse audio
        // without a gesture and reject the play() outright, which on a WebRTC
        // element is a black screen rather than a paused poster — so the
        // second attempt drops the wish rather than the picture, and the
        // tap-to-unmute chip is what carries the wish forward.
        if (!video.muted) {
          video.muted = true;
          try {
            await video.play();
            console.info("[whep] audio refused; playing muted with the unmute chip up");
            setAudioBlocked(true);
            setAutoplayRefused(false);
            return "playing";
          } catch (mutedErr) {
            console.warn("[whep] muted autoplay refused too", mutedErr);
          }
        } else {
          console.warn("[whep] autoplay refused", err);
        }
        setAutoplayRefused(true);
        return "gesture";
      }
    },
    [],
  );

  /**
   * Tear down whatever is attached. Safe to call on nothing.
   *
   * The DELETE inside `close()` is fire-and-forget (see whepClient), so this
   * does not put a network round trip in front of the next handshake — which
   * matters, because on a resume the next handshake is what the viewer is
   * waiting for. MediaMTX drops a reader whose peer connection goes away, so
   * even a DELETE that never lands costs nothing but tidiness.
   */
  const teardown = useCallback((detachElement: boolean) => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    playingRef.current = false;
    lastTimeRef.current = -1;
    if (detachElement) {
      const video = videoRef.current;
      if (video) video.srcObject = null;
    }
  }, []);

  /**
   * One whole handshake: POST, attach, and wait for a picture.
   *
   * Throws a WhepError on anything that means "this attempt did not deliver",
   * INCLUDING a successful handshake that produced no frame inside the
   * deadline — a 201 with nothing behind it is the failure that does not look
   * like one, and it is what a firewall that passes HTTPS and eats UDP
   * produces.
   */
  const runHandshake = useCallback(
    async (generation: number, mediaTimeoutMs: number): Promise<void> => {
      const video = videoRef.current;
      if (!video) throw new WhepError("no_element", "The video element has gone");

      const abort = new AbortController();
      abortRef.current = abort;
      gestureNeededRef.current = false;

      const session = await subscribeWhep({
        endpoint: whepUrl,
        signal: abort.signal,
        onStream: (stream) => {
          if (generationRef.current !== generation) return;
          void attachAndPlay(video, stream).then((outcome) => {
            if (generationRef.current !== generation) return;
            gestureNeededRef.current = outcome === "gesture";
          });
        },
      });

      // A handshake that finished after its successor started. Its session is
      // real and nobody owns it, so it is closed here rather than leaked.
      if (generationRef.current !== generation) {
        session.close();
        throw new WhepError("superseded", "A newer subscribe took over");
      }

      sessionRef.current = session;
      watchConnection(session, generation);

      /**
       * The deadline for a picture, and the two ways out of it.
       *
       * `playingRef` is the element saying frames arrived. `gestureNeededRef`
       * is the browser saying it will show them as soon as somebody taps — a
       * live session either way, and the caller must not spend a retry on it.
       */
      const deadline = Date.now() + mediaTimeoutMs;
      for (;;) {
        if (generationRef.current !== generation) {
          throw new WhepError("superseded", "A newer subscribe took over");
        }
        if (playingRef.current || gestureNeededRef.current) return;
        if (Date.now() > deadline) throw new WhepError("no_media", "No frame inside the deadline");
        await sleep(150);
      }
    },
    // watchConnection is a hoisted declaration in this component's body, and
    // everything it reads is a ref — so the copy captured here stays correct
    // for the life of the mount without having to be memoised around the
    // resubscribe it can trigger.
    [whepUrl, attachAndPlay],
  );

  /**
   * THE FIX, in one function: throw the session away and subscribe again.
   *
   * Called by every resume door, by the frame watchdog, by a peer connection
   * that died, and by the tap overlay. Bounded by MAX_RESUBSCRIBE_ATTEMPTS with
   * the backoff above; when it runs out, the viewer is handed to HLS for this
   * cycle and the router decides whether a later resume may try WHEP again.
   */
  const resubscribe = useCallback(
    async (reason: SubscribeReason, detail?: Record<string, unknown>) => {
      if (disposedRef.current || !recoveryEnabledRef.current) return;
      if (busyRef.current) {
        console.info("[whep] resubscribe already running; ignoring", { reason });
        return;
      }
      busyRef.current = true;

      const first = reason === "mount";
      /**
       * ONE ATTEMPT ON THE MOUNT, THREE ON A RESUME.
       *
       * A mount that fails is most likely an early viewer — the creator is not
       * pushing frames yet — and the right screen for them is the HLS player's
       * counted waiting state, not three more spinners in front of it. PR #60's
       * fast path to that screen is preserved exactly. A RESUME that fails is a
       * different claim: the broadcast was working seconds ago, so it is worth
       * three cheap goes before giving up the latency.
       */
      const maxAttempts = first ? 1 : MAX_RESUBSCRIBE_ATTEMPTS;
      const mediaTimeout = first ? FIRST_MEDIA_TIMEOUT_MS : RESUBSCRIBE_MEDIA_TIMEOUT_MS;

      console.info("[whep] resubscribe", { reason, max_attempts: maxAttempts, ...detail });

      if (!first) setResubscribing(true);
      setPlaying(false);

      let lastReason = "resubscribe_failed";

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (disposedRef.current || !recoveryEnabledRef.current) return;

          // Everything the previous attempt built, gone — including the
          // element's srcObject, so a dead stream cannot be mistaken for a
          // live one by the health check while the next handshake runs.
          teardown(true);
          const generation = generationRef.current;

          try {
            await runHandshake(generation, mediaTimeout);
            if (generationRef.current !== generation) return;
            console.info("[whep] resubscribed", {
              reason,
              attempt,
              needs_gesture: gestureNeededRef.current,
            });
            return;
          } catch (err) {
            lastReason = err instanceof WhepError ? err.code : "handshake_error";
            // Superseded means a newer cycle is already running and owns the
            // outcome; carrying on here would fight it for the element.
            if (lastReason === "superseded") return;
            console.warn("[whep] resubscribe attempt failed", { reason, attempt, code: lastReason });
          }

          const backoff = WHEP_RESUBSCRIBE_BACKOFF_MS[attempt - 1];
          if (attempt < maxAttempts && backoff) await sleep(backoff);
        }

        teardown(true);
        fail(lastReason);
      } finally {
        busyRef.current = false;
        setResubscribing(false);
      }
    },
    [fail, runHandshake, teardown],
  );

  /**
   * Keep the resubscribe reachable from callbacks that must not be re-bound.
   *
   * The connection watcher is attached once per handshake and outlives the
   * render that created it; reading through a ref is what stops a stale
   * closure from resubscribing on behalf of a generation that has gone.
   */
  const resubscribeRef = useRef(resubscribe);
  useEffect(() => {
    resubscribeRef.current = resubscribe;
  }, [resubscribe]);

  /**
   * The connection's own verdict, which is the only failure signal that arrives
   * AFTER a successful handshake.
   *
   * The change from PR #60 is what it DOES with that verdict: `failed` and
   * `closed` used to be the end of WHEP for the session, and are now simply the
   * trigger for a new handshake. A closed connection is not evidence that WHEP
   * cannot work — on iOS it is usually evidence that the tab was suspended.
   */
  function watchConnection(session: WhepSession, generation: number) {
    let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;

    session.pc.addEventListener("connectionstatechange", () => {
      if (generationRef.current !== generation) return;
      const state = session.pc.connectionState;
      console.info("[whep] connection state", { state });

      if (state === "connected") {
        if (disconnectedTimer) {
          clearTimeout(disconnectedTimer);
          disconnectedTimer = null;
        }
        return;
      }

      // A broadcast that has ended drops its connection as a matter of course.
      // The parent is already showing the ended card over us.
      if (!recoveryEnabledRef.current || disposedRef.current) return;

      if (state === "failed" || state === "closed") {
        if (disconnectedTimer) clearTimeout(disconnectedTimer);
        void resubscribeRef.current("connection", { state });
        return;
      }

      if (state === "disconnected" && !disconnectedTimer) {
        // See DISCONNECTED_GRACE_MS: a foreground blip usually clears itself,
        // and rebuilding through one would cost more than it saves.
        disconnectedTimer = setTimeout(() => {
          disconnectedTimer = null;
          if (generationRef.current !== generation) return;
          if (session.pc.connectionState === "connected") return;
          void resubscribeRef.current("connection", { state: "disconnected_grace_expired" });
        }, DISCONNECTED_GRACE_MS);
      }
    });
  }

  /** The first subscribe, and the teardown that ends the mount. */
  useEffect(() => {
    disposedRef.current = false;
    failedRef.current = false;
    void resubscribeRef.current("mount");

    return () => {
      disposedRef.current = true;
      teardown(true);
    };
    // Keyed on whepUrl alone. Nothing else in this component's props can
    // invalidate a peer connection, and re-running on anything that changes
    // every second (the elapsed clock, the viewer count) would rebuild the
    // stream under the viewer once a second.
  }, [whepUrl, teardown]);

  /**
   * The picture's own clock, polled.
   *
   * One interval for the life of the mount, feeding both the health verdict and
   * the watchdog below. `currentTime` rather than `requestVideoFrameCallback`
   * because it is the signal that exists on every iOS version this product
   * targets — see HEALTH_STALE_MS.
   */
  useEffect(() => {
    lastProgressAtRef.current = Date.now();
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused || video.readyState < 2) {
        // Not stalled: stopped, or not started. Keeping the clock fresh is what
        // stops the watchdog firing at a viewer who pressed pause.
        lastProgressAtRef.current = Date.now();
        return;
      }
      if (video.currentTime !== lastTimeRef.current) {
        lastTimeRef.current = video.currentTime;
        lastProgressAtRef.current = Date.now();
      }
    }, FRAME_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  /**
   * "Connected, and frozen." The failure no connection state reports.
   *
   * Independent of every resume door, because this one happens while the tab is
   * in the foreground and nobody switched anything — see
   * FRAME_WATCHDOG_STALE_MS.
   */
  useEffect(() => {
    if (!recoveryEnabled) return;
    const timer = setInterval(() => {
      if (disposedRef.current || busyRef.current) return;
      const video = videoRef.current;
      const pc = sessionRef.current?.pc;
      if (!video || !pc || !playingRef.current) return;
      if (pc.connectionState !== "connected") return;
      if (video.paused) return;
      const stalledMs = Date.now() - lastProgressAtRef.current;
      if (stalledMs < FRAME_WATCHDOG_STALE_MS) return;
      console.warn("[whep] connected but no frames; rebuilding", { stalled_ms: stalledMs });
      void resubscribeRef.current("watchdog", { stalled_ms: stalledMs });
    }, FRAME_POLL_MS);
    return () => clearInterval(timer);
  }, [recoveryEnabled]);

  /**
   * The phone came back. All four doors — see useResumeTriggers.
   *
   * NO GRACE PERIOD AND NO SETTLE DELAY, unlike useWakeRecheck on the HLS path.
   * A suspended peer connection does not recover on its own however long it is
   * given, so a delay here is only ever more black screen. The health check is
   * what keeps this cheap: a session that survived the background answers
   * `true` and nothing is rebuilt.
   */
  useResumeTriggers({
    enabled: recoveryEnabled,
    onResume: useCallback(
      (event) => {
        const healthy = isHealthy();
        console.info("[whep] resume", {
          trigger: event.trigger,
          triggers: event.triggers,
          hidden_ms: event.hiddenMs,
          persisted: event.persisted,
          healthy,
          connection: sessionRef.current?.pc.connectionState ?? "none",
        });
        if (healthy) return;
        void resubscribe(event.trigger, { hidden_ms: event.hiddenMs, persisted: event.persisted });
      },
      [isHealthy, resubscribe],
    ),
  });

  /**
   * Frames are arriving. This is the moment a handshake counts as delivered,
   * and it is read from the element rather than the peer connection because a
   * `connected` connection with a stalled decoder is still a black screen.
   */
  const handlePlaying = useCallback(() => {
    playingRef.current = true;
    lastProgressAtRef.current = Date.now();
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
    // Remembered, so the next resubscribe does not silently re-mute a viewer
    // who has already told us they want sound.
    wantsAudioRef.current = true;
    video.muted = false;
    void video.play().catch(() => undefined);
    setAudioBlocked(false);
  }, []);

  /**
   * The tap that used to do nothing.
   *
   * PREVIOUS BEHAVIOUR: `video.play()`, its rejection swallowed. On a session
   * iOS had closed in the background that is a call against a <video> holding a
   * dead MediaStream — it neither throws nor shows a picture, so the viewer
   * taps, and taps, and nothing happens, permanently, until they reload.
   *
   * NOW: the tap is a resume trigger like any other. Health is checked, and an
   * unhealthy session is rebuilt from scratch before anything is played.
   *
   * THE SYNCHRONOUS play() ON THE FIRST LINE IS NOT REDUNDANT. It is what makes
   * the rest work on iOS: the gesture is only good for the duration of this
   * handler, and the play() that matters happens several hundred milliseconds
   * later inside the handshake, long after it has expired. Calling play() on
   * the element HERE, inside the gesture, is what marks it user-activated so
   * that the later programmatic play is allowed. On a healthy session it is
   * also simply the right thing to do — a viewer who paused wants to resume,
   * and that is all this does.
   */
  const handleTapToPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    const healthy = isHealthy();
    console.info("[whep] tap-to-play", {
      healthy,
      connection: sessionRef.current?.pc.connectionState ?? "none",
    });

    void video
      .play()
      .then(() => setAutoplayRefused(false))
      .catch(() => undefined);

    if (healthy) return;
    void resubscribe("tap", { gesture: true });
  }, [isHealthy, resubscribe]);

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
        /*
          The viewer's audio wish, kept honest.

          `enableAudio` records it when they press the chip, but the framed
          player also has native controls, and a viewer who mutes with those
          would otherwise come back from the next resubscribe with the sound
          on. Read only while a session is actually playing and no rebuild is
          running — the muted play() inside a handshake fires this event too,
          and taking that as the viewer's opinion would forget the wish every
          time it was needed.
        */
        onVolumeChange={() => {
          if (!playingRef.current || busyRef.current) return;
          wantsAudioRef.current = !videoRef.current?.muted;
        }}
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

      {/*
        AUTOPLAY-REFUSED NOW SHOWS ON THE FRAMED PLAYER TOO, and a deliberate
        pause still does not. The distinction is whose decision it was: a
        browser that refused to start is a viewer stuck behind a state their
        native play button cannot always clear, because on a resumed session
        there is nothing behind the element to play — so they get the button
        that rebuilds. A viewer who pressed pause on a desktop made a choice,
        and covering their video with a second play button would be answering a
        question nobody asked. That case stays full-bleed only, where there are
        no native controls to press.

        Hidden while a rebuild is actually running, where the spinner speaks
        for it.
      */}
      {(autoplayRefused || (fullBleed && paused && playing)) && !resubscribing && (
        <button
          type="button"
          onClick={handleTapToPlay}
          className="absolute left-1/2 top-1/2 z-20 inline-flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md transition hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <Play size={26} aria-hidden />
          <span className="sr-only">แตะเพื่อเล่น</span>
        </button>
      )}

      {/*
        One spinner, no counter and no retry button — unlike the HLS player's
        overlay, which has all three. Nothing here is worth waiting out: this
        state lasts at most one resubscribe cycle and then becomes either a
        picture or the HLS player, whose overlay is the one that explains a long
        wait and offers the way out of it.

        Inert while a tap is what is needed: the button above sits at the middle
        of the screen and a pointer-events overlay across it would swallow the
        very gesture this player is asking for.
      */}
      {!playing && !autoplayRefused && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/70 px-6 text-center">
          <div>
            <Loader2 size={28} className="mx-auto animate-spin text-cyan-300" aria-hidden />
            <p className="mt-3 text-sm text-white/80" role="status">
              {resubscribing ? "กำลังเชื่อมต่อไลฟ์ใหม่..." : "กำลังโหลดไลฟ์..."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** A promise that resolves later. Used by the media deadline and the backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
