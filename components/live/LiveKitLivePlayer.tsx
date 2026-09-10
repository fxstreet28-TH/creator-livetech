'use client';

/**
 * The LiveKit viewer — the pre-migration playback path, kept as a fallback.
 *
 * Almost every viewer now watches over LL-HLS (see HlsLivePlayer); this
 * component only renders for a session with no Bunny stream, which means one
 * of two things:
 *
 *  - the row was created before the migration and is still running, or
 *  - `live-create-session` could not reach Bunny and fell back so that the
 *    creator could still broadcast.
 *
 * Keeping it is what lets those sessions play instead of showing an error for
 * something that is not the viewer's problem, and it is the partial-rollback
 * lever in the migration plan: a session forced down this path works exactly
 * as it did before.
 *
 * It is NOT a full copy of the old component. Chat and reactions have moved to
 * the Supabase Realtime channel for every delivery path, so nothing here
 * touches a data channel — the overlay is passed in, and this file's only job
 * is to put remote tracks on the screen.
 *
 * TODO(phase 2B): delete this, together with connectAsSubscriber and the
 * livekit-client dependency, once no session can still be delivered this way.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import {
  DisconnectReason,
  RoomEvent,
  Track,
  connectAsSubscriber,
  createRoom,
  leaveRoom,
  thaiForConnectError,
  type RemoteTrack,
} from '@/lib/live/livekitClient';
import { useRecoveryLadder, type PlaybackHealth } from '@/lib/live/useRecoveryLadder';
import { readIcePath, type IcePathSnapshot } from '@/lib/live/iceDiagnostics';
import { logViewerDiagnostic } from '@/lib/live/viewerDiagnostics';
import { useStaleBuildGuard } from '@/lib/live/useStaleBuildGuard';
import { useVideoFrameWatchdog } from '@/lib/live/useVideoFrameWatchdog';
import { useWakeRecheck } from '@/lib/live/useWakeRecheck';
import { useResumeTriggers } from '@/lib/live/useResumeTriggers';
import {
  watchSourceOrientation,
  type PlayerFit,
  type PlayerPresentation,
  type SourceOrientation,
} from './HlsLivePlayer';
import { LiveRecoveryOverlay } from './LiveRecoveryOverlay';
import { DurationPill, LiveBadge, ViewerCountPill } from './LiveStatsBar';

/**
 * How stale the picture may be before this player is called unhealthy, and how
 * long a resumed room is given to fix itself before it is rebuilt.
 *
 * The same numbers, for the same reasons, as HlsLivePlayer — see the constants
 * at the top of that file. A viewer must not get a different answer to "did my
 * stream survive the background" depending on which transport they happened to
 * be on.
 */
const LIVEKIT_STALE_MS = 4_000;
const RESUME_SETTLE_MS = 800;
const RESTART_DEBOUNCE_MS = 3_000;

/**
 * How long after the first frame to photograph the ICE path.
 *
 * Late enough that a pair has been nominated and has carried some media — a
 * snapshot taken at subscribe time reports a half-finished negotiation and a
 * `bytesReceived` of zero, which reads like a failure and is not one. Early
 * enough to still be inside the window where the 2026-09-10 self-host
 * disconnect happens, so the row describes the path that then died rather than
 * the path that replaced it.
 */
const ICE_SAMPLE_DELAY_MS = 3_000;

/**
 * The disconnects that mean "this broadcast is over for you", as opposed to
 * "the network dropped and it can be picked up again".
 *
 * AN ALLOWLIST, AND THAT DIRECTION IS THE WHOLE FIX. Until 2026-09-10 this
 * component treated EVERY RoomEvent.Disconnected as the end of the broadcast:
 * it showed the "ไลฟ์จบแล้ว" card and told the page the live was over. That is
 * right for a room that was deleted and wrong for a peer connection that died,
 * and the self-host bring-up made the difference impossible to ignore — an
 * iPhone whose connection dropped thirty seconds in was told the creator had
 * finished, while the creator was still broadcasting. The recovery ladder,
 * which exists precisely to reconnect a viewer whose transport failed, never
 * got a chance to run.
 *
 * So only these end it, and anything else — including `undefined` and
 * UNKNOWN_REASON, which is what a dead peer connection actually arrives as —
 * is treated as recoverable. Erring this way is cheap: a viewer whose
 * broadcast really has ended still lands on the ended card within one poll of
 * `useLiveWatch`, which reads the session row and is the authority on the
 * question. Erring the other way is what shipped, and it is a viewer being
 * shown a lie.
 */
const TERMINAL_DISCONNECT_REASONS: ReadonlySet<DisconnectReason> = new Set([
  // Our own leaveRoom() during teardown. Never actually observed here — the
  // effect's `cancelled` flag returns before the handler reads the reason —
  // but listed so the set reads as the complete statement it is.
  DisconnectReason.CLIENT_INITIATED,
  // A second tab on the same broadcast took the identity. Reconnecting would
  // just take it back, and the two tabs would trade it forever.
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.ROOM_CLOSED,
  DisconnectReason.USER_REJECTED,
  DisconnectReason.USER_UNAVAILABLE,
]);

/**
 * The reason's NAME, for the diagnostics row.
 *
 * The wire carries a number and a row that records `9` is a row somebody has to
 * go and look up. The reverse mapping is a plain numeric enum's, so it is
 * guarded rather than trusted: a protocol package that ever switched to string
 * enums would otherwise write `undefined` into the one field that says what
 * happened.
 */
function describeDisconnectReason(reason: DisconnectReason | undefined): string {
  if (reason === undefined) return 'undefined';
  return DisconnectReason[reason] ?? String(reason);
}

export type ViewerPhase = 'connecting' | 'watching' | 'reconnecting' | 'ended' | 'failed';

/**
 * Whatever fit the layout handed down — see PlayerFit in HlsLivePlayer.
 *
 * This file does not decide it and must not: the phone layout picks a fit from
 * the shape this player REPORTS (see onSourceOrientation) so that all three
 * viewer players answer the same question the same way, and the ⛶ button
 * overrides the answer either way.
 *
 * Written onto the element rather than rendered as a prop because the element
 * is the SDK's: tracks are attached with `track.attach()`, which owns
 * srcObject, autoplay and the muted flag.
 */
function applyVideoFit(video: HTMLVideoElement, fullBleed: boolean, fit: PlayerFit) {
  const cover = fullBleed && fit === 'cover';
  video.className = `absolute inset-0 h-full w-full ${cover ? 'object-cover' : 'object-contain'}`;
  // Faces sit in the upper third of a shot — see HlsLivePlayer.
  video.style.objectPosition = cover ? '50% 30%' : '';
}

interface LiveKitLivePlayerProps {
  /** For the diagnostics rows the recovery ladder writes. */
  sessionId: string;
  wsUrl: string;
  /** SECURITY: a LiveKit room credential. Never log it or put it in a URL. */
  token: string;
  title: string;
  elapsedSeconds: number;
  /** From the Realtime channel's presence, like every other screen. */
  viewerCount: number;
  /** The floating reactions and the reaction rail, owned by the page. */
  overlay?: React.ReactNode;
  /** Fired when the broadcast stops, so the page can offer somewhere to go. */
  onEnded: () => void;
  /** See HlsLivePlayer — the two players stay interchangeable, dress included. */
  presentation?: PlayerPresentation;
  /** Full-bleed only. Defaults to 'cover' — see PlayerFit. */
  fit?: PlayerFit;
  /** Off once the broadcast is over — see HlsLivePlayer's copy of this note. */
  recoveryEnabled?: boolean;
  /**
   * The source's shape, whenever it is known or changes.
   *
   * The third of the three players to report it, and it has to: a LiveKit
   * session is what a viewer gets on the legacy delivery path, and the phone
   * layout's letterbox rule cannot have a blind spot in it. See
   * LiveViewerMobile.
   */
  onSourceOrientation?: (orientation: SourceOrientation) => void;
}

export function LiveKitLivePlayer({
  sessionId,
  wsUrl,
  token,
  title,
  elapsedSeconds,
  viewerCount,
  overlay,
  onEnded,
  presentation = 'framed',
  fit = 'cover',
  recoveryEnabled = true,
  onSourceOrientation,
}: LiveKitLivePlayerProps) {
  const fullBleed = presentation === 'fullbleed';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const roomRef = useRef<ReturnType<typeof createRoom> | null>(null);
  /**
   * The presentation, readable from the track-attach callback.
   *
   * Through a ref rather than the connect effect's dependencies: re-running
   * that effect tears down the room and rejoins it, and a viewer rotating a
   * phone across the breakpoint must not be disconnected from the broadcast to
   * change an `object-fit`.
   */
  const fullBleedRef = useRef(fullBleed);
  /** Same reason as fullBleedRef: an object-fit must not rejoin the room. */
  const fitRef = useRef(fit);

  const [phase, setPhase] = useState<ViewerPhase>('connecting');
  const [audioBlocked, setAudioBlocked] = useState(false);
  /**
   * Connected to the room, but nobody is publishing yet.
   *
   * The LiveKit equivalent of a missing HLS manifest, and it matters for
   * exactly the same reason: a viewer who arrives before the creator is not
   * looking at a broken device, and the recovery ladder must sit still through
   * it rather than escalate to reloading their page.
   */
  const [awaitingPublisher, setAwaitingPublisher] = useState(false);
  /** True between the watchdog spotting a frozen picture and frames resuming. */
  const [stalled, setStalled] = useState(false);

  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  /**
   * Same reason as onEndedRef: the connect effect owns the room, and a parent
   * re-rendering with a new callback identity must not rejoin it.
   */
  const onSourceOrientationRef = useRef(onSourceOrientation);
  useEffect(() => {
    onSourceOrientationRef.current = onSourceOrientation;
  }, [onSourceOrientation]);

  /**
   * An ended broadcast is not a fault to recover from.
   *
   * A viewer token is minted for one room and a room with no publisher has
   * nothing to reconnect to, so the ladder is switched off the moment the
   * broadcast is over — otherwise it would climb all the way to reloading the
   * page of someone reading the "ไลฟ์จบแล้ว" card.
   */
  const laddering = recoveryEnabled && phase !== 'ended';

  const health: PlaybackHealth = awaitingPublisher
    ? 'paused'
    : phase === 'watching' && !stalled
      ? 'healthy'
      : 'unhealthy';

  const ladder = useRecoveryLadder({
    sessionId,
    delivery: 'livekit',
    health,
    enabled: laddering,
  });

  /**
   * From the 'relay' rung on, every candidate goes through a TURN server.
   *
   * This is the literal version of what the HLS path can only approximate: the
   * failure being escalated against is a network that will not carry a direct
   * peer connection, and relay is the route that works when nothing else does.
   */
  const iceTransportPolicy: RTCIceTransportPolicy | undefined =
    ladder.step === 'normal' ? undefined : 'relay';

  useEffect(() => {
    let cancelled = false;
    // A NEW Room on every rung, which means a new RTCPeerConnection: the SDK
    // builds one per Room and there is no way to reset the old one in place.
    // That is exactly what the ladder's later rungs are asking for.
    const room = createRoom(undefined, { iceTransportPolicy });
    roomRef.current = room;
    // Captured now: by cleanup time the ref may already point elsewhere, and
    // the elements to tear down are the ones this effect appended.
    const container = containerRef.current;

    /**
     * The orientation watcher on whatever element the SDK last handed over.
     *
     * The element is created on subscribe and destroyed on unsubscribe, and
     * the ladder does both on every rung — so the disposer is held here and
     * called before a new one is bound, or the listeners on a discarded
     * element would keep the observer alive with it.
     */
    let disposeOrientation: (() => void) | null = null;

    /**
     * The subscribed video track, kept only so its stats can be read.
     *
     * `getRTCStatsReport()` is livekit-client's own accessor and reaches the
     * subscriber peer connection without this component reaching into SDK
     * internals — which matters, because the alternative (`room.engine
     * .pcManager.subscriber.pc`) is private and has been renamed twice.
     */
    let videoTrack: RemoteTrack | null = null;
    /**
     * The last ICE path this room was known to be on.
     *
     * Held because a disconnect DESTROYS the evidence: by the time
     * RoomEvent.Disconnected fires the peer connection is closing and its stats
     * report is empty or gone, so "which address was this viewer actually
     * talking to when it died" can only be answered from a sample taken while
     * it was alive. The live read is still attempted first — see onDisconnected.
     */
    let lastIcePath: IcePathSnapshot | null = null;
    let iceSampleTimer: ReturnType<typeof setTimeout> | null = null;

    // Tracks are attached with `track.attach()` rather than bound to elements
    // we render, because the SDK owns srcObject, autoplay and the muted flag —
    // and a hand-rolled <video> gets one of those wrong on Safari.
    const onSubscribed = (track: RemoteTrack) => {
      if (!container) return;

      const element = track.attach();
      if (track.kind === Track.Kind.Video) {
        const video = element as HTMLVideoElement;
        // The FIT is applied here and never derived here: what this element
        // reports upward is the source's shape, and what comes back down is
        // the layout's decision about it — see LiveViewerMobile.
        applyVideoFit(video, fullBleedRef.current, fitRef.current);
        video.playsInline = true;
        disposeOrientation?.();
        disposeOrientation = watchSourceOrientation(video, (orientation) =>
          onSourceOrientationRef.current?.(orientation),
        );

        /**
         * Photograph the network path once this attempt is genuinely playing.
         *
         * One row per room, not a poll: the question it answers — WHICH server
         * addresses were offered, and which one was chosen — is settled at
         * negotiation and does not change for the life of the peer connection.
         * The ladder building a new room is what produces the next sample, and
         * that is exactly when the answer can differ (the relay rung forces a
         * different path).
         */
        videoTrack = track;
        if (iceSampleTimer) clearTimeout(iceSampleTimer);
        iceSampleTimer = setTimeout(() => {
          void (async () => {
            const path = await readIcePath(videoTrack);
            if (cancelled || !path) return;
            lastIcePath = path;
            logViewerDiagnostic({
              sessionId,
              delivery: 'livekit',
              step: 'normal',
              outcome: 'detected',
              detail: { event: 'ice_path', ice_path: path },
            });
          })();
        }, ICE_SAMPLE_DELAY_MS);
      } else {
        // The audio element is present but has nothing to show. Hiding it
        // rather than skipping attach(): a detached audio track is silent.
        element.className = 'hidden';
      }
      container.appendChild(element);
      setAwaitingPublisher(false);
      setStalled(false);
      setPhase('watching');
    };

    const onUnsubscribed = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video) {
        disposeOrientation?.();
        disposeOrientation = null;
        if (videoTrack === track) videoTrack = null;
      }
      track.detach().forEach((element) => element.remove());
    };

    /**
     * The room went away. Whether that is the END of the broadcast or a
     * TRANSPORT FAILURE is the entire question — see
     * TERMINAL_DISCONNECT_REASONS for why it used to be answered wrongly.
     *
     * Every disconnect is recorded either way, with the path it was on. That
     * row is what the self-host A/B test is read from: a `remoteCandidates`
     * carrying four addresses says the server is still advertising its private
     * IPs, and a single public address says the candidate list is fixed and the
     * next disconnect is something else.
     */
    const onDisconnected = (reason?: DisconnectReason) => {
      if (cancelled) return;
      const terminal = reason !== undefined && TERMINAL_DISCONNECT_REASONS.has(reason);

      // Kicked off rather than awaited: the phase change below must not wait on
      // a stats read, and the read is allowed to lose the race with teardown.
      void (async () => {
        // The live report first — it is the truthful one when the peer
        // connection has not finished closing — and the sample taken while
        // playing as the fallback, because usually it has.
        const path = (await readIcePath(videoTrack)) ?? lastIcePath;
        logViewerDiagnostic({
          sessionId,
          delivery: 'livekit',
          step: 'normal',
          outcome: 'detected',
          detail: {
            event: 'disconnected',
            disconnect_reason: describeDisconnectReason(reason),
            terminal,
            ...(path ? { ice_path: path } : {}),
          },
        });
      })();

      if (terminal) {
        setPhase('ended');
        onEndedRef.current();
        return;
      }

      /**
       * Recoverable: hand it to the ladder rather than to the ended card.
       *
       * Setting 'reconnecting' is all it takes — `health` reads it as
       * unhealthy, the ladder starts its clock, and its rungs rebuild the room
       * (and from 'relay' on, force the connection through a TURN server, which
       * is the right escalation for a peer connection that will not stay up).
       * Nothing here retries by hand; doing so would race the ladder.
       */
      setPhase('reconnecting');
    };

    async function connect() {
      try {
        await connectAsSubscriber(room, wsUrl, token);
      } catch (err) {
        if (cancelled) return;
        console.error('[LiveKitLivePlayer] connect failed', err);
        /*
          The specific reason goes to the diagnostics table, not to the screen.

          `thaiForConnectError` produces something accurate and useless to a
          viewer — a token that will not mint, a signalling timeout — and the
          recovery card deliberately says one plain thing with one button on
          it. Losing the detail entirely would be the wrong trade, so it is
          recorded where somebody who can act on it will look.
        */
        logViewerDiagnostic({
          sessionId,
          delivery: 'livekit',
          step: 'normal',
          outcome: 'detected',
          detail: { connect_error: thaiForConnectError(err) },
        });
        setAwaitingPublisher(false);
        setPhase('failed');
        return;
      }
      if (cancelled) return;

      setAudioBlocked(!room.canPlaybackAudio);
      // A viewer who arrives before the broadcaster has published anything
      // sits on 'connecting' until TrackSubscribed fires, which is honest:
      // there is nothing to watch yet. It is also NOT a fault — see
      // awaitingPublisher.
      if (room.remoteParticipants.size > 0) {
        setPhase('watching');
      } else {
        setAwaitingPublisher(true);
      }
    }

    const onReconnecting = () => setPhase('reconnecting');
    const onReconnected = () => setPhase('watching');
    const onAudioStatus = () => setAudioBlocked(!room.canPlaybackAudio);

    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.AudioPlaybackStatusChanged, onAudioStatus);
    room.on(RoomEvent.Disconnected, onDisconnected);

    void connect();

    return () => {
      cancelled = true;
      // By reference rather than removeAllListeners() — the Room is an
      // EventEmitter the SDK also hands to its own internals.
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.AudioPlaybackStatusChanged, onAudioStatus);
      room.off(RoomEvent.Disconnected, onDisconnected);
      roomRef.current = null;
      // Before the elements go: the observer holds the element it watches.
      disposeOrientation?.();
      disposeOrientation = null;
      // The pending sample would otherwise fire against a room this effect has
      // already left. `cancelled` would discard its result, but the timer keeps
      // the track — and through it the peer connection — reachable until then.
      if (iceSampleTimer) clearTimeout(iceSampleTimer);
      iceSampleTimer = null;
      videoTrack = null;
      container?.replaceChildren();
      void leaveRoom(room);
    };
    // attemptKey is what makes the ladder's rungs happen: each escalation
    // leaves the room, drops every element this effect appended, and builds
    // the whole thing again.
  }, [sessionId, wsUrl, token, iceTransportPolicy, ladder.attemptKey]);

  /**
   * Keep the ref — and any element already on screen — in step with the prop.
   *
   * In an effect rather than assigned during render (React refs are not for
   * render-time writes), and it re-applies rather than only recording, because
   * crossing the breakpoint with a track already attached would otherwise
   * leave the SDK's element wearing the previous layout's `object-fit`.
   */
  useEffect(() => {
    fullBleedRef.current = fullBleed;
    fitRef.current = fit;
    const video = containerRef.current?.querySelector('video');
    if (video) applyVideoFit(video, fullBleed, fit);
  }, [fullBleed, fit]);

  /**
   * The SDK owns the element, so it is looked up rather than held in a ref: it
   * is created on track subscribe and replaced whenever the ladder rebuilds
   * the room.
   */
  const getVideo = useCallback(
    () => containerRef.current?.querySelector('video') ?? null,
    [],
  );

  /**
   * "Connected" is precisely the claim that survives a Safari suspension, so
   * the room's own state is not enough: there has to be an element with frames
   * in it, and they have to be recent. A viewer who paused is healthy — the
   * SDK's element carries native controls and they are allowed to use them.
   */
  const lastProgressAtRef = useRef(0);
  const lastTimeRef = useRef(-1);
  useEffect(() => {
    lastProgressAtRef.current = Date.now();
    const timer = setInterval(() => {
      const video = getVideo();
      if (!video) return;
      if (video.paused || video.readyState < 2) {
        lastProgressAtRef.current = Date.now();
        return;
      }
      if (video.currentTime !== lastTimeRef.current) {
        lastTimeRef.current = video.currentTime;
        lastProgressAtRef.current = Date.now();
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [getVideo]);

  const isHealthy = useCallback(() => {
    const video = getVideo();
    if (phase !== 'watching' || stalled || !video) return false;
    if (video.paused) return true;
    if (video.readyState < 2) return false;
    return Date.now() - lastProgressAtRef.current < LIVEKIT_STALE_MS;
  }, [phase, stalled, getVideo]);

  /**
   * The one door every automatic restart goes through — see the same rule, and
   * the same reasoning, in HlsLivePlayer. Three detectors now look at a
   * returning phone and they must not rebuild the room three times.
   */
  const lastRestartAtRef = useRef(0);
  const requestRestart = useCallback(
    (reason: 'wake' | 'watchdog', detail: Record<string, unknown>) => {
      const sinceMs = Date.now() - lastRestartAtRef.current;
      if (sinceMs < RESTART_DEBOUNCE_MS) return;
      lastRestartAtRef.current = Date.now();
      ladder.restartNow(reason, detail);
    },
    [ladder],
  );

  const handleStall = useCallback(
    (detail: Record<string, unknown>) => {
      setStalled(true);
      requestRestart('watchdog', detail);
    },
    [requestRestart],
  );

  useVideoFrameWatchdog({
    getVideo,
    active: laddering && phase === 'watching',
    onStall: handleStall,
  });

  /**
   * Coming back from the background — the LiveKit path's share of PR #67.
   *
   * WHAT WAS VERIFIED RATHER THAN ASSUMED. livekit-client 2.22.1's `Room`
   * exposes no reconnect or resume method: the public surface is `connect`,
   * `disconnect`, `prepareConnection`, `startAudio` and the device switches,
   * with `Reconnecting`/`Reconnected` emitted by its own internal recovery off
   * a lost signalling socket. So there is no SDK call to make on a resume, and
   * its internal reconnect does NOT cover this case — it fires on the socket
   * going away, not on iOS suspending the media element while the room still
   * believes it is connected. The reconnect available to us is the ladder's:
   * tear the room down and build a new one, which is what restartNow does.
   *
   * Which is why this is wired the same way as the other two players rather
   * than left to the SDK.
   */
  useResumeTriggers({
    enabled: laddering,
    onResume: useCallback(
      (event) => {
        const detail = {
          trigger: event.trigger,
          hidden_ms: event.hiddenMs,
          persisted: event.persisted,
        };
        if (isHealthy()) return;
        window.setTimeout(() => {
          if (isHealthy()) return;
          requestRestart('wake', detail);
        }, RESUME_SETTLE_MS);
      },
      [isHealthy, requestRestart],
    ),
  });

  /** The slow backstop. Shares requestRestart, so it cannot double-rebuild. */
  useWakeRecheck({
    enabled: laddering,
    isHealthy,
    onWake: useCallback(
      (detail: Record<string, unknown>) => requestRestart('wake', detail),
      [requestRestart],
    ),
  });

  useStaleBuildGuard({
    sessionId,
    delivery: 'livekit',
    connectFailed: phase === 'failed' || ladder.step !== 'normal',
    enabled: laddering,
  });

  const enableAudio = useCallback(async () => {
    try {
      await roomRef.current?.startAudio();
      setAudioBlocked(false);
    } catch (err) {
      console.error('[LiveKitLivePlayer] startAudio failed', err);
    }
  }, []);

  // Square and borderless on a phone; rounded again from lg, where it sits
  // inside the padded grid. Full-bleed states the viewport outright — `fixed
  // inset-0` at 100vw x 100dvh, no ratio and no intrinsic sizing anywhere in
  // the chain. Same box as HlsLivePlayer's; see its note.
  return (
    <div
      className={
        fullBleed
          ? 'fixed inset-0 z-0 h-[100dvh] w-screen overflow-hidden bg-black'
          : 'relative min-h-0 flex-1 overflow-hidden bg-black lg:rounded-2xl lg:border lg:border-white/10'
      }
    >
      <div ref={containerRef} className="absolute inset-0" aria-label={`ไลฟ์: ${title}`} />

      {/* The page's own top bar carries the same three numbers in full-bleed. */}
      {!fullBleed && (
        <>
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[70%] items-center gap-2">
            <LiveBadge pulse={phase === 'watching'} />
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

      {audioBlocked && phase === 'watching' && (
        <button
          type="button"
          onClick={() => void enableAudio()}
          // Above the reaction rail rather than beside it: on a narrow phone
          // the two would overlap at bottom-centre, and this button is the
          // difference between a silent stream and a working one. In full-bleed
          // it clears the chat column and the input row instead.
          className={`absolute left-1/2 z-20 inline-flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
            fullBleed ? 'top-[38%]' : 'bottom-20'
          }`}
        >
          <Volume2 size={16} aria-hidden />
          แตะเพื่อเปิดเสียง
        </button>
      )}

      {phase === 'ended' ? (
        <ViewerOverlay />
      ) : phase !== 'watching' || stalled || ladder.exhausted ? (
        <LiveRecoveryOverlay
          step={ladder.step}
          secondsToNextStep={ladder.secondsToNextStep}
          exhausted={ladder.exhausted}
          onRetry={ladder.retryNow}
          message={
            awaitingPublisher ? 'กำลังรอสัญญาณจาก Creator...' : 'กำลังเชื่อมต่อวิดีโอ...'
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The dark cover over a finished broadcast.
 *
 * Everything this used to draw — the connecting spinner and the failure panel
 * — is now LiveRecoveryOverlay's, because both of those states are ones the
 * ladder is actively working on and the viewer needs the countdown rather than
 * a static message. 'ended' is the one state with nothing to recover: the page
 * paints its own "ไลฟ์จบแล้ว" panel over the top, and this only keeps a frozen
 * last frame from showing through.
 */
function ViewerOverlay() {
  return <div className="pointer-events-none absolute inset-0 z-20 bg-black/80" aria-hidden />;
}
