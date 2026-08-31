'use client';

/**
 * The publisher half of /creator/live: the LiveKit room, the self-view, the
 * mic/camera controls, and everything that has to keep working when the
 * network does not.
 *
 * It owns the Room object and hands it up to the page (`onRoomChange`) so the
 * chat panel can share the same connection — one room per broadcast, not two.
 *
 * Two writes to `live_sessions` happen from here, and neither is incidental:
 *
 *  - markSessionLive, once connected. The backend inserts the row as
 *    'waiting' and nothing else ever promotes it, so without this the session
 *    is on air with a row that says otherwise — which is what /discover and
 *    the dashboard strip read.
 *  - persistViewerCounts, on a new peak and on a timer. `peak_viewer_count`
 *    has no writer anywhere in the backend, yet live-end-session READS it to
 *    build the session summary. The broadcaster is the one participant that
 *    knows the real number.
 *
 * Both are best-effort: a refused write is logged, never surfaced. Nothing
 * about a wrong number is worth interrupting a broadcast for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, Video, VideoOff, WifiOff } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { markSessionLive, persistViewerCounts } from '@/lib/live/api';
import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAY_MS,
  VIEWER_COUNT_POLL_MS,
  VIEWER_PERSIST_MS,
} from '@/lib/live/constants';
import {
  RoomEvent,
  Track,
  audienceCount,
  connectAsPublisher,
  createRoom,
  leaveRoom,
  thaiForConnectError,
  type Room,
} from '@/lib/live/livekitClient';
import type { BroadcastQuality } from '@/lib/live/types';
import { DurationPill, LiveBadge, ViewerCountPill } from './LiveStatsBar';

export type BroadcastPhase = 'connecting' | 'live' | 'reconnecting' | 'failed';

interface CreatorBroadcasterProps {
  liveSessionId: string;
  wsUrl: string;
  /** SECURITY: a LiveKit room credential. Never log it or put it in a URL. */
  token: string;
  quality: BroadcastQuality;
  videoDeviceId?: string;
  micEnabled: boolean;
  elapsedSeconds: number;
  /** Lifted so the chat panel and the stats bar can share this room. */
  onRoomChange: (room: Room | null) => void;
  onViewerCountChange: (current: number, peak: number) => void;
  onPhaseChange?: (phase: BroadcastPhase) => void;
}

export function CreatorBroadcaster({
  liveSessionId,
  wsUrl,
  token,
  quality,
  videoDeviceId,
  micEnabled,
  elapsedSeconds,
  onRoomChange,
  onViewerCountChange,
  onPhaseChange,
}: CreatorBroadcasterProps) {
  const videoRef = useRef<HTMLDivElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  const peakRef = useRef(0);

  const [phase, setPhase] = useState<BroadcastPhase>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [viewers, setViewers] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(micEnabled);
  /** Bumped by the manual "ลองใหม่", which restarts the whole connect effect. */
  const [attempt, setAttempt] = useState(0);

  // These would land in the connect effect's dependency list, and a parent
  // passing inline arrows would then tear down and rebuild the room on every
  // render. Kept in a ref, written in its own effect rather than during
  // render, so the connect effect depends only on the connection's identity.
  const callbacks = useRef({ onRoomChange, onViewerCountChange, onPhaseChange });
  useEffect(() => {
    callbacks.current = { onRoomChange, onViewerCountChange, onPhaseChange };
  }, [onRoomChange, onViewerCountChange, onPhaseChange]);

  const setPhaseAndReport = useCallback((next: BroadcastPhase) => {
    setPhase(next);
    callbacks.current.onPhaseChange?.(next);
  }, []);

  const persistCounts = useCallback(
    async (current: number, peak: number) => {
      try {
        await persistViewerCounts(getBrowserSupabase(), liveSessionId, current, peak);
      } catch (err) {
        console.error('[CreatorBroadcaster] persist counts failed', err);
      }
    },
    [liveSessionId],
  );

  /** Recompute the audience from LiveKit and raise the stored peak. */
  const refreshViewers = useCallback(() => {
    const current = audienceCount(roomRef.current);
    setViewers(current);
    if (current > peakRef.current) {
      peakRef.current = current;
      // A new maximum is written immediately rather than waiting for the
      // timer: live-end-session reads peak_viewer_count to build the summary,
      // and a peak set thirty seconds before "จบไลฟ์" would otherwise be lost.
      void persistCounts(current, current);
    }
    callbacks.current.onViewerCountChange(current, peakRef.current);
  }, [persistCounts]);

  useEffect(() => {
    let cancelled = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const room = createRoom(quality);
    roomRef.current = room;

    /**
     * Paint the local camera track into the self-view.
     *
     * `track.attach()` builds the <video> rather than binding a ref to one we
     * rendered: the SDK owns the element's srcObject, muted flag and autoplay
     * attributes, and a hand-rolled element gets one of them wrong on Safari.
     */
    const attachSelfView = () => {
      const container = videoRef.current;
      const publication = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const track = publication?.track;
      if (!container || !track) return;

      container.replaceChildren();
      const element = track.attach() as HTMLVideoElement;
      // Muted is not a preference: an unmuted self-view is a feedback loop.
      element.muted = true;
      element.playsInline = true;
      element.className = 'h-full w-full object-contain';
      container.appendChild(element);
    };

    const onDisconnected = () => {
      if (cancelled) return;
      // livekit-client has already exhausted its own internal retries by the
      // time this fires, so these are full reconnects on top of that.
      if (retries >= MAX_RECONNECT_ATTEMPTS) {
        setError('ไลฟ์หลุด — การเชื่อมต่อขาดหาย');
        setPhaseAndReport('failed');
        return;
      }
      retries += 1;
      setPhaseAndReport('reconnecting');
      retryTimer = setTimeout(() => {
        if (!cancelled) void connect();
      }, RECONNECT_DELAY_MS * retries);
    };

    async function connect() {
      setError(null);
      setPhaseAndReport(retries === 0 ? 'connecting' : 'reconnecting');

      try {
        await connectAsPublisher(room, {
          wsUrl,
          token,
          quality,
          videoDeviceId,
          micEnabled,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[CreatorBroadcaster] connect failed', err);
        setError(thaiForConnectError(err));
        setPhaseAndReport('failed');
        return;
      }
      if (cancelled) return;

      retries = 0;
      attachSelfView();
      setCamOn(room.localParticipant.isCameraEnabled);
      setMicOn(room.localParticipant.isMicrophoneEnabled);
      setPhaseAndReport('live');
      callbacks.current.onRoomChange(room);
      refreshViewers();

      try {
        await markSessionLive(getBrowserSupabase(), liveSessionId);
      } catch (err) {
        console.error('[CreatorBroadcaster] markSessionLive failed', err);
      }
    }

    const onReconnecting = () => setPhaseAndReport('reconnecting');
    const onReconnected = () => {
      setPhaseAndReport('live');
      attachSelfView();
    };

    room.on(RoomEvent.ParticipantConnected, refreshViewers);
    room.on(RoomEvent.ParticipantDisconnected, refreshViewers);
    room.on(RoomEvent.LocalTrackPublished, attachSelfView);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      // Each handler is removed by reference rather than with
      // removeAllListeners(): the Room is an EventEmitter the SDK also hands
      // to its own internals, and tearing down every listener on it is a
      // bigger hammer than unsubscribing what this component subscribed.
      room.off(RoomEvent.ParticipantConnected, refreshViewers);
      room.off(RoomEvent.ParticipantDisconnected, refreshViewers);
      room.off(RoomEvent.LocalTrackPublished, attachSelfView);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      callbacks.current.onRoomChange(null);
      roomRef.current = null;
      void leaveRoom(room);
    };
    // micEnabled is the STARTING mic state only — toggling it afterwards goes
    // through the button below, not through a reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessionId, wsUrl, token, quality, videoDeviceId, attempt]);

  // The backstop for a participant that left without a clean disconnect, whose
  // event never arrives.
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = setInterval(refreshViewers, VIEWER_COUNT_POLL_MS);
    return () => clearInterval(timer);
  }, [phase, refreshViewers]);

  // The row only feeds the discover card and the summary, so it is written far
  // more slowly than the number on screen is refreshed.
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = setInterval(() => {
      void persistCounts(audienceCount(roomRef.current), peakRef.current);
    }, VIEWER_PERSIST_MS);
    return () => clearInterval(timer);
  }, [phase, persistCounts]);

  /** The bottom-left level meter, polled off the local participant. */
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = setInterval(() => {
      setAudioLevel(roomRef.current?.localParticipant.audioLevel ?? 0);
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  const toggleCamera = async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !room.localParticipant.isCameraEnabled;
    try {
      await room.localParticipant.setCameraEnabled(next);
      setCamOn(next);
    } catch (err) {
      console.error('[CreatorBroadcaster] toggle camera failed', err);
    }
  };

  const toggleMic = async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !room.localParticipant.isMicrophoneEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicOn(next);
    } catch (err) {
      console.error('[CreatorBroadcaster] toggle mic failed', err);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-black">
        <div ref={videoRef} className="h-full w-full" aria-label="ภาพที่กำลังถ่ายทอด" />

        <div className="pointer-events-none absolute left-3 top-3 z-10">
          <LiveBadge pulse={phase === 'live'} />
        </div>

        <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2">
          <ViewerCountPill count={viewers} />
          <DurationPill seconds={elapsedSeconds} />
        </div>

        {/* Audio level, bottom-left. Sits over the video rather than beside it
            so a creator watching their own framing sees it without looking
            away. */}
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-full bg-black/55 px-2.5 py-1.5 backdrop-blur-sm">
          {micOn ? (
            <Mic size={13} className="text-white" aria-hidden />
          ) : (
            <MicOff size={13} className="text-rose-300" aria-hidden />
          )}
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/20">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-cyan-400 to-purple-400 transition-[width] duration-150"
              style={{ width: `${micOn ? Math.round(Math.min(1, audioLevel * 3) * 100) : 0}%` }}
            />
          </span>
        </div>

        {phase !== 'live' && <ConnectionOverlay phase={phase} error={error} onRetry={() => setAttempt((n) => n + 1)} />}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <ControlButton
          onClick={toggleMic}
          active={micOn}
          label={micOn ? 'ปิดไมโครโฟน' : 'เปิดไมโครโฟน'}
          icon={micOn ? <Mic size={18} aria-hidden /> : <MicOff size={18} aria-hidden />}
        />
        <ControlButton
          onClick={toggleCamera}
          active={camOn}
          label={camOn ? 'ปิดกล้อง' : 'เปิดกล้อง'}
          icon={camOn ? <Video size={18} aria-hidden /> : <VideoOff size={18} aria-hidden />}
        />
        <span className="ml-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs tabular-nums text-white/50">
          {quality}
        </span>
      </div>
    </div>
  );
}

/**
 * What covers the video while the connection is not up.
 *
 * Three attempts happen by themselves; after that the creator gets a button,
 * because an automatic retry loop that never ends looks identical to a frozen
 * page.
 */
function ConnectionOverlay({
  phase,
  error,
  onRetry,
}: {
  phase: BroadcastPhase;
  error: string | null;
  onRetry: () => void;
}) {
  if (phase === 'failed') {
    return (
      <div role="alert" className="absolute inset-0 z-20 grid place-items-center bg-black/85 px-6 text-center">
        <div>
          <WifiOff size={30} className="mx-auto text-rose-300" aria-hidden />
          <p className="mt-3 text-base font-semibold text-white">ไลฟ์หลุด — ลองใหม่</p>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-white/55">
            {error ?? 'การเชื่อมต่อขาดหาย'}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-cyan-400 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            เชื่อมต่อใหม่
          </button>
          <p className="mt-3 text-xs leading-relaxed text-white/40">
            ไลฟ์ยังไม่ถูกปิด — กด &ldquo;จบไลฟ์&rdquo; เพื่อปิดและดูสรุปผล
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

function ControlButton({
  onClick,
  active,
  label,
  icon,
}: {
  onClick: () => void | Promise<void>;
  active: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      aria-pressed={active}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
        active
          ? 'bg-white/10 text-white hover:bg-white/15'
          : 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
      }`}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </button>
  );
}
