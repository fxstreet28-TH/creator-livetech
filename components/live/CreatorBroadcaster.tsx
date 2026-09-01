'use client';

/**
 * The publisher half of /creator/live: the camera, the filter canvas, the
 * LiveKit connection, and the call that starts delivery to the CDN.
 *
 * WHAT THE PIPELINE LOOKS LIKE FROM HERE
 *
 *   getUserMedia --> canvas (the look) --> LiveKit publish --> RoomComposite
 *     egress --> RTMP --> Bunny Live --> LL-HLS --> viewers
 *
 * Two of those arrows are new and both matter:
 *
 *  - THE CANVAS. The camera is opened here rather than by LiveKit's
 *    `setCameraEnabled`, because the frames have to pass through a canvas that
 *    applies the creator's chosen look before anything encodes them. That is
 *    what makes the filter visible to viewers; until this migration it was a
 *    CSS effect on the creator's own screen and the UI had to admit as much.
 *  - THE EGRESS. Started AFTER the publisher is connected and publishing, not
 *    at go-live. An egress bills per minute from the moment it starts, and
 *    starting it when the session row is created would charge an abandoned
 *    go-live for compositing an empty room.
 *
 * The room contains the creator and, once delivery starts, LiveKit's egress
 * worker. It does NOT contain the audience — viewers pull HLS from a CDN — so
 * the viewer count and the reactions floating over the self-view both come
 * from the Supabase Realtime channel, via the page. This component receives
 * them as props and owns neither.
 *
 * One write to `live_sessions` happens from here: persistViewerCounts. The
 * peak it maintains is what live-end-session reads to build the session
 * summary AND to price the broadcast, and nothing else writes it. Best-effort
 * — a refused write is logged, never surfaced. Nothing about a wrong number is
 * worth interrupting a broadcast for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, Sparkles, Video, VideoOff, WifiOff } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { markSessionLive, persistViewerCounts, startLiveEgress } from '@/lib/live/api';
import {
  EGRESS_START_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAY_MS,
  VIEWER_PERSIST_MS,
} from '@/lib/live/constants';
import {
  RoomEvent,
  Track,
  connectAsPublisher,
  createRoom,
  leaveRoom,
  localPublication,
  resolutionFor,
  thaiForConnectError,
  thaiForMediaError,
  type Room,
} from '@/lib/live/livekitClient';
import type { BroadcastQuality, LiveDelivery } from '@/lib/live/types';
import {
  createFilteredStream,
  filterLabelFor,
  type FilteredStream,
  type FilterId,
} from '@/lib/live/cameraFilters';
import type { FloatingReaction } from '@/lib/live/reactions';
import { CameraFilterSelector } from './CameraFilterSelector';
import { FloatingReactionsLayer } from './FloatingReactionsLayer';
import { DurationPill, LiveBadge, ViewerCountPill } from './LiveStatsBar';

export type BroadcastPhase = 'connecting' | 'live' | 'reconnecting' | 'failed';

interface CreatorBroadcasterProps {
  liveSessionId: string;
  wsUrl: string;
  /** SECURITY: a LiveKit room credential. Never log it or put it in a URL. */
  token: string;
  quality: BroadcastQuality;
  /** 'llhls' when a Bunny stream exists; 'livekit' when its create fell back. */
  delivery: LiveDelivery;
  videoDeviceId?: string;
  micEnabled: boolean;
  elapsedSeconds: number;
  /** The look chosen on the setup screen; changeable from the bottom bar. */
  filterId: FilterId;
  onFilterIdChange: (id: FilterId) => void;
  /** From the Realtime channel's presence, via the page. */
  viewerCount: number;
  /** The viewers' reactions, floating over the self-view. Received, never sent. */
  reactions: FloatingReaction[];
  onPhaseChange?: (phase: BroadcastPhase) => void;
}

export function CreatorBroadcaster({
  liveSessionId,
  wsUrl,
  token,
  quality,
  delivery,
  videoDeviceId,
  micEnabled,
  elapsedSeconds,
  filterId,
  onFilterIdChange,
  viewerCount,
  reactions,
  onPhaseChange,
}: CreatorBroadcasterProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lookButtonRef = useRef<HTMLButtonElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  const filteredRef = useRef<FilteredStream | null>(null);

  const [lookOpen, setLookOpen] = useState(false);
  const [phase, setPhase] = useState<BroadcastPhase>('connecting');
  const [error, setError] = useState<string | null>(null);
  /**
   * Delivery to the CDN, separately from the LiveKit connection.
   *
   * They fail independently and mean different things: a creator whose room is
   * up but whose egress refused IS broadcasting — to nobody — and telling them
   * "connected" would be a lie they only discover from an empty viewer count.
   */
  const [deliveryLive, setDeliveryLive] = useState(delivery !== 'llhls');
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(micEnabled);
  /** Bumped by the manual "ลองใหม่", which restarts the whole connect effect. */
  const [attempt, setAttempt] = useState(0);

  const onPhaseChangeRef = useRef(onPhaseChange);
  useEffect(() => {
    onPhaseChangeRef.current = onPhaseChange;
  }, [onPhaseChange]);

  const setPhaseAndReport = useCallback((next: BroadcastPhase) => {
    setPhase(next);
    onPhaseChangeRef.current?.(next);
  }, []);

  // A look change is a variable assignment inside the draw loop, not a
  // republish — the published track is the canvas, and the canvas does not
  // care what is drawn onto it.
  useEffect(() => {
    filteredRef.current?.setFilter(filterId);
  }, [filterId]);

  useEffect(() => {
    let cancelled = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let egressTimer: ReturnType<typeof setTimeout> | null = null;
    let camera: MediaStream | null = null;
    let filtered: FilteredStream | null = null;
    const room = createRoom(quality);
    roomRef.current = room;

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

    /**
     * Ask the backend to point a LiveKit egress at this room's Bunny stream.
     *
     * Delayed rather than immediate: the egress composites whatever is in the
     * room at the instant it starts, and catching the moment before the first
     * camera frame is published makes Bunny's opening second black. Idempotent
     * on the backend, so the reconnect path calling it again is safe.
     */
    const beginDelivery = async () => {
      if (cancelled || delivery !== 'llhls') return;

      const { error: egressError } = await startLiveEgress(
        getBrowserSupabase(),
        liveSessionId,
      );
      if (cancelled) return;

      if (egressError) {
        console.error('[CreatorBroadcaster] start egress failed', egressError);
        setDeliveryError(egressError.message);
        return;
      }
      setDeliveryError(null);
      setDeliveryLive(true);
    };

    async function connect() {
      setError(null);
      setPhaseAndReport(retries === 0 ? 'connecting' : 'reconnecting');

      // The camera is opened once and reused across reconnects. Re-opening it
      // per attempt is how you hit "camera is in use by another application"
      // on Windows Chrome, which holds a device briefly after release.
      if (!camera) {
        try {
          const { width, height, frameRate } = resolutionFor(quality);
          camera = await navigator.mediaDevices.getUserMedia({
            video: {
              ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
              width: { ideal: width },
              height: { ideal: height },
              frameRate: { ideal: frameRate },
            },
            audio: true,
          });
        } catch (err) {
          if (cancelled) return;
          console.error('[CreatorBroadcaster] getUserMedia failed', err);
          setError(thaiForMediaError(err));
          setPhaseAndReport('failed');
          return;
        }
      }

      if (!filtered) {
        try {
          filtered = await createFilteredStream(camera, filterId, resolutionFor(quality).frameRate);
          filteredRef.current = filtered;
        } catch (err) {
          if (cancelled) return;
          console.error('[CreatorBroadcaster] filter pipeline failed', err);
          setError('เปิดฟิลเตอร์กล้องไม่สำเร็จ กรุณาลองใหม่');
          setPhaseAndReport('failed');
          return;
        }
      }

      // The self-view shows the CANVAS, not the camera — so what the creator
      // is looking at is exactly the frames the audience receives, filter
      // included. Muted is not a preference: an unmuted self-view is a
      // feedback loop.
      if (videoRef.current) {
        videoRef.current.srcObject = filtered.stream;
        videoRef.current.muted = true;
        void videoRef.current.play().catch(() => {});
      }

      try {
        await connectAsPublisher(room, {
          wsUrl,
          token,
          quality,
          stream: filtered.stream,
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
      setCamOn(true);
      setMicOn(micEnabled);
      setPhaseAndReport('live');

      egressTimer = setTimeout(() => void beginDelivery(), EGRESS_START_DELAY_MS);

      // A backstop only: start_egress promotes the row server-side. It still
      // matters for a session delivered over LiveKit, where no egress starts
      // and so nothing else would move it off 'waiting'.
      try {
        await markSessionLive(getBrowserSupabase(), liveSessionId);
      } catch (err) {
        console.error('[CreatorBroadcaster] markSessionLive failed', err);
      }
    }

    const onReconnecting = () => setPhaseAndReport('reconnecting');
    const onReconnected = () => setPhaseAndReport('live');

    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (egressTimer) clearTimeout(egressTimer);
      // Each handler is removed by reference rather than with
      // removeAllListeners(): the Room is an EventEmitter the SDK also hands
      // to its own internals, and tearing down every listener on it is a
      // bigger hammer than unsubscribing what this component subscribed.
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      roomRef.current = null;
      filteredRef.current = null;
      void leaveRoom(room);
      // Order matters: the filter stops its draw loop and its canvas track,
      // then the camera itself is released. Stopping the camera first leaves
      // the loop drawing a dead <video>.
      filtered?.stop();
      camera?.getTracks().forEach((track) => track.stop());
    };
    // micEnabled and filterId are the STARTING values only — both are changed
    // afterwards through the controls below, not through a reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessionId, wsUrl, token, quality, videoDeviceId, delivery, attempt]);

  /**
   * Write the audience size back to the row.
   *
   * The number comes from the Realtime channel's presence, which is the only
   * thing that knows it now that viewers are not room participants.
   * live-end-session reads the resulting peak to build the summary and price
   * the broadcast, so without this every session reports zero viewers and
   * bills as if nobody watched.
   */
  useEffect(() => {
    if (phase !== 'live') return;

    const write = () => {
      void persistViewerCounts(getBrowserSupabase(), liveSessionId, viewerCount).catch((err) => {
        console.error('[CreatorBroadcaster] persist counts failed', err);
      });
    };

    write();
    const timer = setInterval(write, VIEWER_PERSIST_MS);
    return () => clearInterval(timer);
  }, [phase, liveSessionId, viewerCount]);

  /** The bottom-left level meter, polled off the local participant. */
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = setInterval(() => {
      setAudioLevel(roomRef.current?.localParticipant.audioLevel ?? 0);
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  /**
   * Camera and mic are toggled by MUTING the publication, not by unpublishing.
   *
   * Unpublishing would renegotiate, and the egress composites the room live —
   * a track that comes and goes makes Bunny's ingest reconnect, which every
   * viewer sees as a stall. A muted track keeps the connection and sends
   * black or silence, which is what "camera off" should look like anyway.
   */
  const toggleTrack = async (source: Track.Source, next: boolean) => {
    const publication = localPublication(roomRef.current, source);
    if (!publication) return;
    try {
      if (next) await publication.unmute();
      else await publication.mute();
    } catch (err) {
      console.error('[CreatorBroadcaster] toggle track failed', err);
    }
  };

  const toggleCamera = async () => {
    const next = !camOn;
    await toggleTrack(Track.Source.Camera, next);
    setCamOn(next);
  };

  const toggleMic = async () => {
    const next = !micOn;
    await toggleTrack(Track.Source.Microphone, next);
    setMicOn(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-black">
        {/* No CSS filter on this element any more. The look is already in the
            pixels — this is the canvas stream, which is what the encoder, the
            egress, Bunny and every viewer receive. */}
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label="ภาพที่กำลังถ่ายทอด"
          className="h-full w-full object-contain"
        />

        <FloatingReactionsLayer reactions={reactions} />

        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2">
          <LiveBadge pulse={phase === 'live'} />
          {phase === 'live' && !deliveryLive && (
            <span className="rounded-full bg-amber-500/85 px-2.5 py-1 text-[11px] font-semibold text-black">
              กำลังเริ่มส่งสัญญาณ...
            </span>
          )}
        </div>

        <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2">
          <ViewerCountPill count={viewerCount} />
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

      {/* Delivery failed but the room is up. Said out loud rather than left to
          be inferred from a viewer count that never moves. */}
      {deliveryError && phase === 'live' && (
        <div
          role="alert"
          className="shrink-0 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100"
        >
          {deliveryError} — ผู้ชมยังดูไม่ได้ในขณะนี้
        </div>
      )}

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
        <div
          className="relative"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !lookOpen) return;
            setLookOpen(false);
            lookButtonRef.current?.focus();
          }}
        >
          {lookOpen && (
            <>
              {/* A transparent full-screen catcher rather than a document
                  listener: the bottom bar is the last thing between a creator
                  and "จบไลฟ์", and a stray listener that outlives this popover
                  would sit over that button. */}
              <button
                type="button"
                aria-label="ปิดตัวเลือกลุค"
                onClick={() => setLookOpen(false)}
                className="fixed inset-0 z-30 cursor-default"
              />
              <div className="absolute bottom-full left-0 z-40 mb-2 w-[min(22rem,80vw)] rounded-2xl border border-white/10 bg-[#0c101b] p-4 shadow-2xl shadow-black/60">
                {/* Stays open after a choice: picking a look is comparing
                    looks, and a popover that closes on the first tap makes
                    trying the next one a second trip to the bottom bar. */}
                <CameraFilterSelector value={filterId} onChange={onFilterIdChange} />
              </div>
            </>
          )}
          <button
            ref={lookButtonRef}
            type="button"
            aria-expanded={lookOpen}
            aria-haspopup="dialog"
            onClick={() => setLookOpen((current) => !current)}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <Sparkles size={16} aria-hidden />
            เลือกลุค
            <span className="text-white/40">{filterLabelFor(filterId)}</span>
          </button>
        </div>

        <span className="ml-auto rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs tabular-nums text-white/50">
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
