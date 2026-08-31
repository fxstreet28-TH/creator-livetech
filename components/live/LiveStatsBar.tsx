'use client';

/**
 * The broadcaster's numbers — how many people are watching, how long the
 * broadcast has been running, and what it has earned so far — plus the three
 * overlay chips both live screens paint on top of their video.
 *
 * The chips live here rather than in a fourth file because they are the same
 * three numbers in a smaller form: the 🔴 LIVE pill, the viewer count, and the
 * elapsed timer. CreatorBroadcaster and ViewerLivePlayer both import them.
 */

import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { formatCount, formatDuration } from '@/lib/creator/format';
import { PrismStar } from '@/components/star/PrismStar';
import type { BroadcastQuality } from '@/lib/live/types';

/**
 * Seconds elapsed since `startedAt`, ticking once a second.
 *
 * `started_at` is written by the backend at row insert, which is a moment
 * before LiveKit connects — so this is the duration the session summary will
 * bill against, not the duration of the video, and the two differ by a couple
 * of seconds. Showing the billed one is the honest choice on a creator screen.
 */
export function useElapsedSeconds(startedAt: string | null): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    if (Number.isNaN(start)) return;

    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return seconds;
}

/** The pulsing red pill. `pulse` is off once the session has ended. */
export function LiveBadge({ pulse = true }: { pulse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/90 px-2.5 py-1 text-[11px] font-bold text-white shadow-lg shadow-red-500/30">
      <span className={`h-1.5 w-1.5 rounded-full bg-white ${pulse ? 'animate-pulse' : ''}`} />
      LIVE
    </span>
  );
}

export function ViewerCountPill({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] tabular-nums text-white backdrop-blur-sm">
      <Eye size={13} aria-hidden />
      {formatCount(count)}
      <span className="sr-only">คนกำลังรับชม</span>
    </span>
  );
}

export function DurationPill({ seconds }: { seconds: number }) {
  return (
    <span className="rounded-full bg-black/55 px-2.5 py-1 text-[11px] tabular-nums text-white backdrop-blur-sm">
      {formatDuration(seconds)}
    </span>
  );
}

interface LiveStatsBarProps {
  viewerCount: number;
  peakViewerCount: number;
  elapsedSeconds: number;
  tipStars: number;
  quality: BroadcastQuality | null;
  maxViewers: number | null;
}

export function LiveStatsBar({
  viewerCount,
  peakViewerCount,
  elapsedSeconds,
  tipStars,
  quality,
  maxViewers,
}: LiveStatsBarProps) {
  return (
    <section
      aria-label="สถิติไลฟ์"
      className="shrink-0 rounded-2xl border border-white/10 bg-white/[0.03] p-3 backdrop-blur-xl"
    >
      <dl className="grid grid-cols-3 gap-2 text-center">
        <Stat label="กำลังดู" value={formatCount(viewerCount)} />
        <Stat label="สูงสุด" value={formatCount(peakViewerCount)} />
        <Stat label="เวลา" value={formatDuration(elapsedSeconds)} />
      </dl>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/8 pt-3 text-[11px] text-white/45">
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          {/* TODO: swap to the Variant C Deluxe star when that PR integrates. */}
          <PrismStar size={14} showChargeEffects={false} animated={false} aria-label="Stars" />
          {formatCount(tipStars)} ดาว
          {/* The tip button is a placeholder this sprint, so this counter only
              moves if a tip lands from somewhere else. It reads 0 all sprint.
              TODO(week-4): real tipping. */}
        </span>
        <span className="tabular-nums">
          {quality ?? '—'}
          {maxViewers != null && ` · สูงสุด ${formatCount(maxViewers)} คน`}
        </span>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] text-white/40">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold tabular-nums text-white">{value}</dd>
    </div>
  );
}
