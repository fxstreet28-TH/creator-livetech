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
  RoomEvent,
  Track,
  connectAsSubscriber,
  createRoom,
  leaveRoom,
  thaiForConnectError,
  type RemoteTrack,
} from '@/lib/live/livekitClient';
import { useRecoveryLadder, type PlaybackHealth } from '@/lib/live/useRecoveryLadder';
import { logViewerDiagnostic } from '@/lib/live/viewerDiagnostics';
import { useStaleBuildGuard } from '@/lib/live/useStaleBuildGuard';
import { useVideoFrameWatchdog } from '@/lib/live/useVideoFrameWatchdog';
import { useWakeRecheck } from '@/lib/live/useWakeRecheck';
import {
  watchSourceOrientation,
  type PlayerFit,
  type PlayerPresentation,
  type SourceOrientation,
} from './HlsLivePlayer';
import { LiveRecoveryOverlay } from './LiveRecoveryOverlay';
import { DurationPill, LiveBadge, ViewerCountPill } from './LiveStatsBar';

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
      }
      track.detach().forEach((element) => element.remove());
    };

    /**
     * The broadcaster left, or the server closed the room.
     *
     * Either way this is "the live is over" for a viewer, not a connection
     * problem to retry: a viewer token is minted for one room, and a room with
     * no publisher has nothing to reconnect to.
     */
    const onDisconnected = () => {
      if (cancelled) return;
      setPhase('ended');
      onEndedRef.current();
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

  const handleStall = useCallback(
    (detail: Record<string, unknown>) => {
      setStalled(true);
      ladder.restartNow('watchdog', detail);
    },
    [ladder],
  );

  /**
   * The SDK owns the element, so it is looked up rather than held in a ref: it
   * is created on track subscribe and replaced whenever the ladder rebuilds
   * the room.
   */
  const getVideo = useCallback(
    () => containerRef.current?.querySelector('video') ?? null,
    [],
  );

  useVideoFrameWatchdog({
    getVideo,
    active: laddering && phase === 'watching',
    onStall: handleStall,
  });

  useWakeRecheck({
    enabled: laddering,
    // "Connected" is precisely the claim that survives a Safari suspension, so
    // the room's own state is not enough: there has to be an element with
    // frames in it.
    isHealthy: useCallback(() => {
      const video = getVideo();
      return phase === 'watching' && !stalled && !!video && !video.paused && video.readyState >= 2;
    }, [phase, stalled, getVideo]),
    onWake: useCallback(
      (detail: Record<string, unknown>) => ladder.restartNow('wake', detail),
      [ladder],
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
