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
import { DurationPill, LiveBadge, ViewerCountPill } from './LiveStatsBar';

export type ViewerPhase = 'connecting' | 'watching' | 'reconnecting' | 'ended' | 'failed';

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
}

export function LiveKitLivePlayer({
  wsUrl,
  token,
  title,
  elapsedSeconds,
  viewerCount,
  overlay,
  onEnded,
}: LiveKitLivePlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const roomRef = useRef<ReturnType<typeof createRoom> | null>(null);

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
        element.className = 'absolute inset-0 h-full w-full object-contain';
        (element as HTMLVideoElement).playsInline = true;
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

  const enableAudio = useCallback(async () => {
    try {
      await roomRef.current?.startAudio();
      setAudioBlocked(false);
    } catch (err) {
      console.error('[LiveKitLivePlayer] startAudio failed', err);
    }
  }, []);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-black">
      <div ref={containerRef} className="absolute inset-0" aria-label={`ไลฟ์: ${title}`} />

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

      {overlay}

      {audioBlocked && phase === 'watching' && (
        <button
          type="button"
          onClick={() => void enableAudio()}
          // Above the reaction rail rather than beside it: on a narrow phone
          // the two would overlap at bottom-centre, and this button is the
          // difference between a silent stream and a working one.
          className="absolute bottom-20 left-1/2 z-20 inline-flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
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
    return <div className="absolute inset-0 z-20 bg-black/80" aria-hidden />;
  }

  if (phase === 'failed') {
    return (
      <div role="alert" className="absolute inset-0 z-20 grid place-items-center bg-black/85 px-6 text-center">
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
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/70 px-6 text-center">
      <div>
        <Loader2 size={28} className="mx-auto animate-spin text-cyan-300" aria-hidden />
        <p className="mt-3 text-sm text-white/80" role="status">
          {phase === 'reconnecting' ? 'กำลังเชื่อมต่อใหม่...' : 'กำลังเชื่อมต่อ...'}
        </p>
      </div>
    </div>
  );
}
