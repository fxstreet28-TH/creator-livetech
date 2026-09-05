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
import { Loader2, Volume2, WifiOff } from 'lucide-react';
import {
  RoomEvent,
  Track,
  connectAsSubscriber,
  createRoom,
  leaveRoom,
  thaiForConnectError,
  type RemoteTrack,
} from '@/lib/live/livekitClient';
import type { PlayerPresentation } from './HlsLivePlayer';
import { DurationPill, LiveBadge, ViewerCountPill } from './LiveStatsBar';

export type ViewerPhase = 'connecting' | 'watching' | 'reconnecting' | 'ended' | 'failed';

/**
 * `cover` in full-bleed, and only for a portrait source.
 *
 * Same rule as HlsLivePlayer: filling a portrait phone is the point of that
 * layout, but a landscape broadcast cropped to 9:19.5 loses two thirds of the
 * frame — a creator streaming from a desktop would be a strip of their
 * background — so a landscape source is letterboxed instead. Written onto the
 * element rather than rendered as a prop because the element is the SDK's:
 * tracks are attached with `track.attach()`, which owns srcObject, autoplay
 * and the muted flag.
 */
function applyVideoFit(video: HTMLVideoElement, fullBleed: boolean) {
  const cover =
    fullBleed &&
    video.videoWidth > 0 &&
    video.videoHeight > 0 &&
    video.videoHeight >= video.videoWidth;
  video.className = `absolute inset-0 h-full w-full ${cover ? 'object-cover' : 'object-contain'}`;
}

interface LiveKitLivePlayerProps {
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
}

export function LiveKitLivePlayer({
  wsUrl,
  token,
  title,
  elapsedSeconds,
  viewerCount,
  overlay,
  onEnded,
  presentation = 'framed',
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

  const [phase, setPhase] = useState<ViewerPhase>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    let cancelled = false;
    const room = createRoom();
    roomRef.current = room;
    // Captured now: by cleanup time the ref may already point elsewhere, and
    // the elements to tear down are the ones this effect appended.
    const container = containerRef.current;

    // Tracks are attached with `track.attach()` rather than bound to elements
    // we render, because the SDK owns srcObject, autoplay and the muted flag —
    // and a hand-rolled <video> gets one of those wrong on Safari.
    const onSubscribed = (track: RemoteTrack) => {
      if (!container) return;

      const element = track.attach();
      if (track.kind === Track.Kind.Video) {
        const video = element as HTMLVideoElement;
        const refit = () => applyVideoFit(video, fullBleedRef.current);
        refit();
        // The source's dimensions are not known when the element is created,
        // and a creator who rotates their phone mid-broadcast changes them.
        video.addEventListener('loadedmetadata', refit);
        video.addEventListener('resize', refit);
        video.playsInline = true;
      } else {
        // The audio element is present but has nothing to show. Hiding it
        // rather than skipping attach(): a detached audio track is silent.
        element.className = 'hidden';
      }
      container.appendChild(element);
      setPhase('watching');
    };

    const onUnsubscribed = (track: RemoteTrack) => {
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
        setError(thaiForConnectError(err));
        setPhase('failed');
        return;
      }
      if (cancelled) return;

      setAudioBlocked(!room.canPlaybackAudio);
      // A viewer who arrives before the broadcaster has published anything
      // sits on 'connecting' until TrackSubscribed fires, which is honest:
      // there is nothing to watch yet.
      if (room.remoteParticipants.size > 0) setPhase('watching');
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
      container?.replaceChildren();
      void leaveRoom(room);
    };
  }, [wsUrl, token]);

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
    const video = containerRef.current?.querySelector('video');
    if (video) applyVideoFit(video, fullBleed);
  }, [fullBleed]);

  const enableAudio = useCallback(async () => {
    try {
      await roomRef.current?.startAudio();
      setAudioBlocked(false);
    } catch (err) {
      console.error('[LiveKitLivePlayer] startAudio failed', err);
    }
  }, []);

  // Square and borderless on a phone, where the player is edge-to-edge and a
  // rounded border would just be a hairline of page colour around the video.
  // Rounded again from lg, where it sits inside the padded grid. Full-bleed
  // fills whatever box the page gave it, which there is the viewport.
  return (
    <div
      className={
        fullBleed
          ? 'absolute inset-0 overflow-hidden bg-black'
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

      {phase !== 'watching' && <ViewerOverlay phase={phase} error={error} />}
    </div>
  );
}

function ViewerOverlay({ phase, error }: { phase: ViewerPhase; error: string | null }) {
  if (phase === 'ended') {
    // The page paints its own "ไลฟ์จบแล้ว" panel with a link to the creator;
    // this only keeps the video area from showing a frozen last frame.
    return <div className="pointer-events-none absolute inset-0 z-20 bg-black/80" aria-hidden />;
  }

  if (phase === 'failed') {
    return (
      <div
        role="alert"
        // Inert, for the same reason HlsLivePlayer's is: nothing here is
        // pressable, and it covers every control on the screen.
        className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/85 px-6 text-center"
      >
        <div>
          <WifiOff size={30} className="mx-auto text-rose-300" aria-hidden />
          <p className="mt-3 text-base font-semibold text-white">เข้าชมไลฟ์ไม่สำเร็จ</p>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-white/55">
            {error ?? 'การเชื่อมต่อขาดหาย'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/70 px-6 text-center">
      <div>
        <Loader2 size={28} className="mx-auto animate-spin text-cyan-300" aria-hidden />
        <p className="mt-3 text-sm text-white/80" role="status">
          {phase === 'reconnecting' ? 'กำลังเชื่อมต่อใหม่...' : 'กำลังเชื่อมต่อ...'}
        </p>
      </div>
    </div>
  );
}
