'use client';

/**
 * One labelled usage bar: "วิดีโอ  [████░]  3 / 5".
 *
 * Shared by the dashboard widget and /creator/quota so the two never disagree
 * about where "ใกล้เต็ม" starts. The colour is derived from the percentage
 * here rather than passed in, for the same reason.
 *
 * The default fill is the app's aurora gradient; it shifts warm at 60% and
 * red past 85%, per the sprint brief's thresholds (see usageState).
 */

import { usageState, type UsageState } from '@/lib/creator/quota';

const FILL_CLASS: Record<UsageState, string> = {
  ok: 'bg-gradient-to-r from-purple-500 to-cyan-400',
  warn: 'bg-gradient-to-r from-amber-400 to-orange-400',
  high: 'bg-gradient-to-r from-orange-500 to-rose-500',
  full: 'bg-gradient-to-r from-rose-500 to-red-500',
};

const NOTE_CLASS: Record<UsageState, string> = {
  ok: 'text-white/40',
  warn: 'text-amber-200/80',
  high: 'text-rose-200',
  full: 'text-rose-200',
};

const NOTE_TEXT: Partial<Record<UsageState, string>> = {
  warn: 'ใกล้เต็ม',
  high: 'จะเต็มแล้ว',
  full: 'เต็มแล้ว',
};

interface QuotaBarProps {
  label: string;
  /** Rendered on the right of the label row, e.g. "3 / 5" or "0.4 / 2 GB". */
  valueLabel: string;
  percent: number;
  /**
   * True when the number behind the bar could not be established — today's
   * live hours while the platform kill switch is on, for instance. The track
   * renders empty with a dash instead of a misleading 0% or 100%.
   */
  unknown?: boolean;
  /** Extra line under the bar. The state note is appended to it. */
  hint?: string;
  compact?: boolean;
}

export function QuotaBar({
  label,
  valueLabel,
  percent,
  unknown = false,
  hint,
  compact = false,
}: QuotaBarProps) {
  const state = usageState(percent);
  const note = unknown ? null : NOTE_TEXT[state];

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className={`truncate text-white/70 ${compact ? 'text-xs' : 'text-sm'}`}>{label}</span>
        <span
          className={`shrink-0 tabular-nums font-semibold text-white ${compact ? 'text-xs' : 'text-sm'}`}
        >
          {unknown ? '—' : valueLabel}
        </span>
      </div>

      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={unknown ? undefined : percent}
        className={`mt-2 w-full overflow-hidden rounded-full bg-white/10 ${compact ? 'h-1.5' : 'h-2.5'}`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${FILL_CLASS[state]}`}
          style={{ width: unknown ? '0%' : `${percent}%` }}
        />
      </div>

      {(hint || note) && (
        <p className={`mt-1.5 text-[11px] leading-relaxed ${NOTE_CLASS[state]}`}>
          {[hint, note].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );
}
