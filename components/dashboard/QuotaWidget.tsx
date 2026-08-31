'use client';

/**
 * The creator's usage this month, as a compact card on /dashboard.
 *
 * Exists to prevent a surprise: without it the first time a creator learns
 * about their tier's ceiling is a rejected upload, several minutes into
 * picking a file and writing a description. Three bars is the whole story —
 * videos this month, live hours today, storage — with the fourth (peak
 * viewers) left to /creator/quota, since it is a ceiling nobody plans around
 * mid-scroll.
 *
 * Renders nothing at all for a viewer with no `creators` row, and nothing
 * while either lookup is in flight: a skeleton in the middle of the dashboard
 * feed for a card most users will never have is worse than the card simply
 * not being there.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useCreatorProfile } from '@/lib/hooks/useCreatorProfile';
import { useCreatorQuota } from '@/lib/hooks/useCreatorQuota';
import {
  formatGb,
  formatHours,
  isVideoQuotaFull,
  usagePercent,
  usageState,
} from '@/lib/creator/quota';
import { QuotaBar } from '@/components/creator/QuotaBar';
import { TierBadge } from '@/components/creator/TierBadge';

export function QuotaWidget() {
  const { creatorId } = useCreatorProfile();
  const { snapshot, loading, error } = useCreatorQuota(creatorId);

  // Not a creator, still loading, or the read failed: say nothing. The quota
  // page is where a creator goes when they want to be told about a failure;
  // an error box wedged into the dashboard feed helps nobody.
  if (!creatorId || loading || error || !snapshot) return null;

  const { usage, limits, live } = snapshot;

  const videoPercent = usagePercent(usage.videosUploaded, limits.maxVideosPerMonth);
  const storagePercent = usagePercent(usage.storageGb, limits.storageQuotaGb);
  const livePercent = live ? usagePercent(live.hoursUsedToday, live.hoursLimitPerDay) : 0;

  // The upgrade CTA earns its place only once something is actually filling
  // up; on a fresh month it is an ad.
  const worst = Math.max(videoPercent, storagePercent, live?.known ? livePercent : 0);
  const pressing = usageState(worst) !== 'ok';

  return (
    <section
      aria-labelledby="quota-widget-title"
      className="w-full rounded-2xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur-xl sm:max-w-md"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="quota-widget-title" className="text-sm font-bold text-white">
          📊 การใช้งานเดือนนี้
        </h2>
        <TierBadge tier={usage.tier} size="sm" />
      </div>

      <div className="mt-4 flex flex-col gap-3.5">
        <QuotaBar
          label="วิดีโอ"
          valueLabel={`${usage.videosUploaded} / ${limits.maxVideosPerMonth}`}
          percent={videoPercent}
          compact
        />
        <QuotaBar
          label="ไลฟ์วันนี้"
          valueLabel={
            live ? `${formatHours(live.hoursUsedToday)} / ${formatHours(live.hoursLimitPerDay)}` : '—'
          }
          percent={livePercent}
          unknown={!live?.known}
          compact
        />
        <QuotaBar
          label="พื้นที่"
          valueLabel={`${formatGb(usage.storageGb)} / ${formatGb(limits.storageQuotaGb)}`}
          percent={storagePercent}
          compact
        />
      </div>

      {isVideoQuotaFull(snapshot) && (
        <p role="status" className="mt-4 text-xs leading-relaxed text-rose-200">
          ครบโควตาวิดีโอเดือนนี้แล้ว — อัปเกรดเพื่อใช้งานต่อ
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-3">
        <Link
          href="/creator/quota"
          className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-white/60 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          ดูรายละเอียด
          <ArrowRight size={13} aria-hidden />
        </Link>

        {pressing && (
          <Link
            href="/settings/plan"
            className="inline-flex min-h-11 items-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-4 text-xs font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            อัปเกรดแพ็กเกจ
          </Link>
        )}
      </div>
    </section>
  );
}
