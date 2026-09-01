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
import { attachHlsStream, type HlsHandle, type HlsPhase } from '@/lib/live/hlsPlayer';
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setPhase('loading');
    setError(null);

    const handle = attachHlsStream({
      video,
      playbackUrl,
      latencyMode,
      onPhaseChange: setPhase,
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
  }, [playbackUrl, latencyMode]);

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

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-black">
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

      {phase !== 'playing' && <PlayerOverlay phase={phase} error={error} />}
    </div>
  );
}

/**
 * What covers the video while it is not playing.
 *
 * 'waiting' gets its own copy and is NOT phrased as a problem: it is the
 * normal state of a viewer who opened the page a few seconds before the
 * creator's frames reached Bunny, and telling them something went wrong would
 * be both wrong and enough to make them leave.
 */
function PlayerOverlay({ phase, error }: { phase: HlsPhase; error: string | null }) {
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
      </div>
    </div>
  );
}
