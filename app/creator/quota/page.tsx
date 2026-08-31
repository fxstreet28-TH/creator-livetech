'use client';

/**
 * /creator/quota — the full picture behind the dashboard widget.
 *
 * Four bars (videos, live hours today, storage, peak viewers) and the tier
 * comparison table, which is the part that turns "you have used 5 of 5" into
 * a decision. The numbers come from the same snapshot the widget and the two
 * gates use, so nothing here can disagree with what the upload page says.
 *
 * The upgrade CTA points at /settings/plan, which does not exist yet — plan
 * self-service is post-launch. It is left as a placeholder rather than
 * removed because it is the honest next step, and every other quota surface
 * already links there.
 */

import Link from 'next/link';
import { Check, Minus, RefreshCw } from 'lucide-react';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useCreatorProfile } from '@/lib/hooks/useCreatorProfile';
import { useCreatorQuota } from '@/lib/hooks/useCreatorQuota';
import {
  formatGb,
  formatHours,
  nextMonthResetLabel,
  usagePercent,
  type CreatorQuotaSnapshot,
  type TierLimits,
} from '@/lib/creator/quota';
import { formatCount } from '@/lib/creator/format';
import { CreatorPageShell } from '@/components/creator/CreatorPageShell';
import { QuotaBar } from '@/components/creator/QuotaBar';
import { TierBadge } from '@/components/creator/TierBadge';

export default function CreatorQuotaPage() {
  const { ready } = useRequireAuth();
  const profile = useCreatorProfile();
  const { snapshot, loading, error, refresh } = useCreatorQuota(profile.creatorId);

  if (!ready) return <AuthPending />;

  return (
    <CreatorPageShell
      title="โควตาการใช้งาน"
      subtitle="ดูว่าคุณใช้ไปเท่าไหร่แล้วในเดือนนี้ และแพ็กเกจของคุณรองรับอะไรบ้าง"
      width="wide"
      action={
        snapshot ? (
          <button
            type="button"
            onClick={refresh}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-4 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <RefreshCw size={15} aria-hidden />
            รีเฟรช
          </button>
        ) : undefined
      }
    >
      {profile.loading || loading ? (
        <div className="h-96 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      ) : !profile.creatorId ? (
        <NotACreatorNotice error={profile.error} />
      ) : error || !snapshot ? (
        <div
          role="alert"
          className="rounded-2xl border border-rose-400/25 bg-rose-500/10 p-6 text-sm text-rose-100"
        >
          {error ?? 'โหลดข้อมูลโควตาไม่สำเร็จ กรุณาลองใหม่'}
        </div>
      ) : (
        <QuotaDetail snapshot={snapshot} />
      )}
    </CreatorPageShell>
  );
}

function QuotaDetail({ snapshot }: { snapshot: CreatorQuotaSnapshot }) {
  const { usage, limits, live, allTiers } = snapshot;

  const videoPercent = usagePercent(usage.videosUploaded, limits.maxVideosPerMonth);
  const storagePercent = usagePercent(usage.storageGb, limits.storageQuotaGb);
  const livePercent = live ? usagePercent(live.hoursUsedToday, live.hoursLimitPerDay) : 0;
  const viewerPercent = usagePercent(usage.peakConcurrentViewers, limits.maxConcurrentViewers);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
        <div className="min-w-0">
          <p className="text-xs text-white/45">แพ็กเกจปัจจุบัน</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-bold text-white">
            {limits.displayName}
            <TierBadge tier={limits.tier} />
          </p>
        </div>
        <p className="text-xs leading-relaxed text-white/45">
          รอบเดือน {usage.monthKey} · รีเซ็ตวันที่ {nextMonthResetLabel()}
        </p>
      </section>

      {/* The creator's own row can be throttled independently of the counters
          — the backend refuses uploads and live outright in that state, so it
          is said plainly rather than left to be inferred from four bars that
          all look fine. */}
      {(usage.status === 'throttled' || usage.status === 'suspended') && (
        <p
          role="alert"
          className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-5 py-4 text-sm leading-relaxed text-rose-100"
        >
          บัญชีของคุณถูกจำกัดการใช้งานชั่วคราว กรุณาติดต่อทีมงานเพื่อตรวจสอบ
        </p>
      )}

      <section className="grid gap-4 sm:grid-cols-2">
        <UsageCard title="วิดีโอเดือนนี้">
          <QuotaBar
            label="อัปโหลดแล้ว"
            valueLabel={`${usage.videosUploaded} / ${limits.maxVideosPerMonth}`}
            percent={videoPercent}
            hint={`ความยาวสูงสุด ${limits.maxVideoLengthMinutes} นาทีต่อคลิป`}
          />
        </UsageCard>

        <UsageCard title="ไลฟ์วันนี้">
          <QuotaBar
            label="ใช้ไปแล้ว"
            valueLabel={
              live
                ? `${formatHours(live.hoursUsedToday)} / ${formatHours(live.hoursLimitPerDay)}`
                : '—'
            }
            percent={livePercent}
            unknown={!live?.known}
            hint={
              live?.known
                ? 'รีเซ็ตทุกเที่ยงคืน (เวลาไทย)'
                : 'ยังอ่านเวลาไลฟ์ของวันนี้ไม่ได้ในขณะนี้'
            }
          />
        </UsageCard>

        <UsageCard title="พื้นที่จัดเก็บ">
          <QuotaBar
            label="ใช้ไปแล้ว"
            valueLabel={`${formatGb(usage.storageGb)} / ${formatGb(limits.storageQuotaGb)}`}
            percent={storagePercent}
            hint="ลบวิดีโอเก่าเพื่อคืนพื้นที่"
          />
        </UsageCard>

        <UsageCard title="ผู้ชมพร้อมกันสูงสุด">
          <QuotaBar
            label="สถิติเดือนนี้"
            valueLabel={`${formatCount(usage.peakConcurrentViewers)} / ${formatCount(limits.maxConcurrentViewers)}`}
            percent={viewerPercent}
            hint={`ไลฟ์ไปแล้ว ${formatCount(usage.liveSessionsCount)} ครั้งในเดือนนี้`}
          />
        </UsageCard>
      </section>

      <TierComparison tiers={allTiers} currentTier={limits.tier} />

      <section className="rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-600/25 to-cyan-500/15 p-6 text-center">
        <p className="text-base font-bold text-white">ต้องการโควตาเพิ่ม?</p>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/65">
          อัปเกรดเป็น Pro เพื่ออัปโหลดได้ 15 คลิปต่อเดือน ไลฟ์ได้วันละ 1 ชั่วโมง และพื้นที่ 15 GB
        </p>
        <Link
          href="/settings/plan"
          className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-6 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          อัปเกรดเป็น Pro — 300 บาท/เดือน
        </Link>
        {/* TODO(post-launch): /settings/plan is not built yet. */}
        <p className="mt-3 text-[11px] text-white/40">ระบบอัปเกรดด้วยตัวเองกำลังจะเปิดให้ใช้งานเร็ว ๆ นี้</p>
      </section>
    </div>
  );
}

function UsageCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
      <h2 className="mb-4 text-sm font-bold text-white">{title}</h2>
      {children}
    </div>
  );
}

interface ComparisonRow {
  label: string;
  value: (tier: TierLimits) => React.ReactNode;
}

const COMPARISON_ROWS: ComparisonRow[] = [
  { label: 'วิดีโอต่อเดือน', value: (t) => `${t.maxVideosPerMonth} คลิป` },
  { label: 'ความยาวต่อคลิป', value: (t) => `${t.maxVideoLengthMinutes} นาที` },
  { label: 'ไลฟ์ต่อวัน', value: (t) => formatHours(t.maxLiveHoursPerDay) },
  { label: 'ผู้ชมพร้อมกัน', value: (t) => `${formatCount(t.maxConcurrentViewers)} คน` },
  { label: 'พื้นที่จัดเก็บ', value: (t) => formatGb(t.storageQuotaGb) },
  { label: 'คุณภาพไลฟ์สูงสุด', value: (t) => t.maxLiveQuality },
  { label: 'วิดีโอยาว', value: (t) => <Mark on={t.canUploadLongForm} /> },
  { label: 'บันทึกไลฟ์', value: (t) => <Mark on={t.canRecordLive} /> },
  { label: 'ขายแบบจ่ายต่อชิ้น (PPV)', value: (t) => <Mark on={t.canPpv} /> },
];

/**
 * Tier comparison. Enterprise is filtered out unless the creator is on it:
 * it is an arranged plan with no listed price, so putting it in a table whose
 * point is "which one should I buy" only adds a column nobody can act on.
 */
function TierComparison({ tiers, currentTier }: { tiers: TierLimits[]; currentTier: string }) {
  const visible = tiers.filter((tier) => tier.tier !== 'enterprise' || tier.tier === currentTier);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
      <h2 className="text-sm font-bold text-white">เปรียบเทียบแพ็กเกจ</h2>

      {/* Its own scroll container: a table this wide must not make the page
          scroll sideways on a phone. */}
      <div className="mt-4 -mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <thead>
            <tr>
              <th scope="col" className="w-40 pb-3 text-left text-xs font-medium text-white/45">
                ความสามารถ
              </th>
              {visible.map((tier) => (
                <th key={tier.tier} scope="col" className="pb-3 text-center">
                  <span className="flex flex-col items-center gap-1">
                    <TierBadge tier={tier.tier} size="sm" />
                    <span className="text-[11px] font-normal text-white/45">
                      {tier.monthlyPriceThb > 0
                        ? `${formatCount(tier.monthlyPriceThb)} ฿/เดือน`
                        : 'ฟรี'}
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARISON_ROWS.map((row) => (
              <tr key={row.label} className="border-t border-white/8">
                <th scope="row" className="py-3 pr-3 text-left text-xs font-normal text-white/55">
                  {row.label}
                </th>
                {visible.map((tier) => (
                  <td
                    key={tier.tier}
                    className={`py-3 text-center tabular-nums ${
                      tier.tier === currentTier ? 'font-bold text-white' : 'text-white/70'
                    }`}
                  >
                    {row.value(tier)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Mark({ on }: { on: boolean }) {
  return on ? (
    <Check size={16} className="mx-auto text-emerald-300" aria-label="รองรับ" />
  ) : (
    <Minus size={16} className="mx-auto text-white/25" aria-label="ไม่รองรับ" />
  );
}

/** Same notice the upload and live screens show, for the same reason. */
function NotACreatorNotice({ error }: { error: string | null }) {
  if (error) {
    return (
      <div role="alert" className="rounded-2xl border border-rose-400/25 bg-rose-500/10 p-6 text-sm text-rose-100">
        {error}
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center backdrop-blur-xl">
      <p className="text-base font-semibold text-white">คุณยังไม่ได้เป็น Creator</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/55">
        โควตาการอัปโหลดและไลฟ์มีให้เฉพาะบัญชี Creator ที่ผ่านการตรวจสอบแล้ว
      </p>
      <Link
        href="/creator/apply"
        className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        สมัครเป็น Creator
      </Link>
    </div>
  );
}
