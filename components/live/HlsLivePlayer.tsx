'use client';

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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Volume2, WifiOff } from 'lucide-react';
import {
  MANIFEST_RETRY_BUDGET_MS,
  attachHlsStream,
  type HlsHandle,
  type HlsPhase,
} from '@/lib/live/hlsPlayer';
import type { LatencyMode } from '@/lib/live/types';
import { DurationPill, LiveBadge, ViewerCountPill } from './LiveStatsBar';

interface HlsLivePlayerProps {
  playbackUrl: string;
  latencyMode: LatencyMode;
  title: string;
  elapsedSeconds: number;
  viewerCount: number;
  /** Rendered over the video — the floating reactions and the reaction rail. */
  overlay?: React.ReactNode;
}

export function HlsLivePlayer({
  playbackUrl,
  latencyMode,
  title,
  elapsedSeconds,
  viewerCount,
  overlay,
}: HlsLivePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handleRef = useRef<HlsHandle | null>(null);

  const [phase, setPhase] = useState<HlsPhase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
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
   * Phase changes come from the player, which is the external system this
   * component is synchronising with — so the wait clock is started and cleared
   * here, in its callback, rather than in an effect watching `phase`.
   */
  const handlePhaseChange = useCallback((next: HlsPhase) => {
    if (next === 'waiting') {
      // Only on entering the wait: a stream that stalls, recovers and stalls
      // again should count from the start of the CURRENT wait, and the retry
      // loop reports 'waiting' repeatedly while one wait is still running.
      waitStartedAtRef.current ??= Date.now();
    } else {
      waitStartedAtRef.current = null;
      setWaitingSeconds(0);
    }
    setPhase(next);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setError(null);

    const handle = attachHlsStream({
      video,
      playbackUrl,
      latencyMode,
      onPhaseChange: handlePhaseChange,
      onError: setError,
      onAudioBlocked: setAudioBlocked,
    });
    handleRef.current = handle;

    return () => {
      handleRef.current = null;
      // Not optional. hls.js keeps timers, a MediaSource and in-flight segment
      // requests alive; an undestroyed instance keeps pulling — and billing —
      // bandwidth after the component has gone.
      handle.destroy();
    };
  }, [playbackUrl, latencyMode, handlePhaseChange]);

  /**
   * Recomputed from the start time on every tick rather than incremented.
   *
   * A `+ 1` per second silently under-counts whenever the browser throttles
   * background timers — which is precisely the tab a viewer leaves open while
   * waiting for a creator to appear.
   */
  useEffect(() => {
    if (phase !== 'waiting') return;
    const timer = setInterval(() => {
      const startedAt = waitStartedAtRef.current;
      if (startedAt !== null) setWaitingSeconds(Math.floor((Date.now() - startedAt) / 1000));
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
      if (document.visibilityState === 'visible') handleRef.current?.seekToLive();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const enableAudio = useCallback(async () => {
    await handleRef.current?.unmute();
  }, []);

  // Square and borderless on a phone, where the player is edge-to-edge and a
  // rounded border would just be a hairline of page colour around the video.
  // Rounded again from lg, where it sits inside the padded grid.
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-black lg:rounded-2xl lg:border lg:border-white/10">
      <video
        ref={videoRef}
        playsInline
        // Controls are on because this is a <video> the viewer owns — unlike
        // the LiveKit element, which the SDK built and drove. It is also the
        // only way back to playing after a browser refuses even muted
        // autoplay, which iOS Low Power Mode does.
        controls
        aria-label={`ไลฟ์: ${title}`}
        className="absolute inset-0 h-full w-full object-contain"
      />

      <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[70%] items-center gap-2">
        <LiveBadge pulse={phase === 'playing'} />
        <span className="truncate rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm">
          {title}
        </span>
      </div>

      <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2">
        <ViewerCountPill count={viewerCount} />
        <DurationPill seconds={elapsedSeconds} />
      </div>

      {overlay}

      {audioBlocked && phase === 'playing' && (
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

      {phase !== 'playing' && (
        <PlayerOverlay phase={phase} error={error} waitingSeconds={waitingSeconds} />
      )}
    </div>
  );
}

/** m:ss, for the wait counter. */
function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
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
  if (phase === 'error') {
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
          {phase === 'waiting' ? 'กำลังรอสัญญาณจาก Creator...' : 'กำลังโหลดไลฟ์...'}
        </p>
        {phase === 'waiting' && (
          <p className="mt-1 text-xs tabular-nums text-white/40">
            {formatWait(waitingSeconds)} / รอสูงสุด {formatWait(MANIFEST_RETRY_BUDGET_MS / 1000)}
          </p>
        )}
      </div>
    </div>
  );
}
