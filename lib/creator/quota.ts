'use client';

/**
 * What a creator has used this month, and what their tier allows.
 *
 * Three sources, because no single one has the whole picture:
 *
 *  - `creator_content_quotas` — the month's counters (videos, storage, peak
 *    viewers). One row per creator per month_key, RLS-scoped to the owner.
 *  - `content_tier_limits` — the ceilings for every tier. Public read, and
 *    read in full rather than filtered, because /creator/quota shows the
 *    tier comparison table and that costs the same round trip.
 *  - `check_creator_can_golive` — the DAILY live figure. It is deliberately
 *    not read off the quota row: `live_minutes_used` there is a monthly
 *    total, while the tier's ceiling (`max_live_hours_per_day`) is per day,
 *    and dividing one by the other produces a number that is wrong every day
 *    of the month except the first. The RPC sums today's ended sessions,
 *    which is what the backend enforces against.
 *
 * Nothing here is cached (non-negotiable #4): every screen that shows a quota
 * fetches it, so a creator never sees a count that a completed upload has
 * already made stale.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchLiveQuota } from '@/lib/live/api';
import type { BroadcastQuality } from '@/lib/live/types';

/** content_tier_limits.tier / creators.content_tier. */
export type CreatorTier = 'free' | 'pro' | 'star' | 'enterprise';

export const TIER_ORDER: CreatorTier[] = ['free', 'pro', 'star', 'enterprise'];

export function isCreatorTier(value: unknown): value is CreatorTier {
  return typeof value === 'string' && (TIER_ORDER as string[]).includes(value);
}

/** creator_content_quotas.status CHECK. */
export type QuotaStatus = 'active' | 'warning' | 'throttled' | 'suspended';

/** One row of creator_content_quotas, camelCased. */
export interface CreatorQuotaUsage {
  monthKey: string;
  tier: CreatorTier;
  videosUploaded: number;
  /** Monthly total. NOT comparable to the tier's per-day live ceiling. */
  liveMinutesUsedThisMonth: number;
  liveSessionsCount: number;
  peakConcurrentViewers: number;
  storageGb: number;
  status: QuotaStatus;
  /** English, from Postgres. Never rendered raw. */
  throttleReason: string | null;
}

/** One row of content_tier_limits, camelCased. */
export interface TierLimits {
  tier: CreatorTier;
  displayName: string;
  maxVideosPerMonth: number;
  maxVideoLengthMinutes: number;
  maxLiveHoursPerDay: number;
  maxConcurrentViewers: number;
  maxVideoQuality: string;
  maxLiveQuality: BroadcastQuality;
  storageQuotaGb: number;
  canRecordLive: boolean;
  canUploadLongForm: boolean;
  canPpv: boolean;
  monthlyPriceThb: number;
}

/** Today's live usage, from check_creator_can_golive. */
export interface LiveDailyUsage {
  hoursUsedToday: number;
  hoursLimitPerDay: number;
  /**
   * False when the RPC refused for a reason that is not the daily limit — the
   * platform kill switch, or a throttled account. It answers 0 hours
   * remaining in those cases too, and reporting that as "you have used your
   * whole day" would be a lie. The bar renders as unknown instead.
   */
  known: boolean;
}

export interface CreatorQuotaSnapshot {
  usage: CreatorQuotaUsage;
  /** The creator's own tier row. */
  limits: TierLimits;
  /** Every tier, cheapest first — the comparison table on /creator/quota. */
  allTiers: TierLimits[];
  /** Null when the RPC could not be read; the rest of the card still renders. */
  live: LiveDailyUsage | null;
}

/** Thai, renderable. */
const READ_ERROR = 'โหลดข้อมูลโควตาไม่สำเร็จ กรุณาลองใหม่';

/**
 * 'YYYY-MM' in Asia/Bangkok, matching Postgres `current_month_key()`.
 *
 * The browser's own timezone is not used: a creator in London at 23:00 on the
 * 31st is already in next month in Bangkok, and the row they would be shown
 * (or worse, told is empty) is not the row the backend counts against.
 */
export function currentMonthKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

const num = (value: unknown): number => {
  // numeric comes back from PostgREST as a string; integer comes back a number.
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
};

function toUsage(row: Record<string, unknown>): CreatorQuotaUsage {
  const tier = row.tier;
  const status = row.status;
  return {
    monthKey: String(row.month_key ?? currentMonthKey()),
    tier: isCreatorTier(tier) ? tier : 'free',
    videosUploaded: num(row.videos_uploaded_count),
    liveMinutesUsedThisMonth: num(row.live_minutes_used),
    liveSessionsCount: num(row.live_sessions_count),
    peakConcurrentViewers: num(row.peak_concurrent_viewers),
    storageGb: num(row.total_storage_gb),
    status: typeof status === 'string' ? (status as QuotaStatus) : 'active',
    throttleReason: typeof row.throttle_reason === 'string' ? row.throttle_reason : null,
  };
}

function toLimits(row: Record<string, unknown>): TierLimits {
  const tier = row.tier;
  return {
    tier: isCreatorTier(tier) ? tier : 'free',
    displayName: String(row.display_name ?? ''),
    maxVideosPerMonth: num(row.max_videos_per_month),
    maxVideoLengthMinutes: num(row.max_video_length_minutes),
    maxLiveHoursPerDay: num(row.max_live_hours_per_day),
    maxConcurrentViewers: num(row.max_concurrent_viewers),
    maxVideoQuality: String(row.max_video_quality ?? '480p'),
    maxLiveQuality: (row.max_live_quality ?? '360p') as BroadcastQuality,
    storageQuotaGb: num(row.storage_quota_gb),
    canRecordLive: row.can_record_live === true,
    canUploadLongForm: row.can_upload_long_form === true,
    canPpv: row.can_ppv === true,
    monthlyPriceThb: num(row.monthly_price_thb),
  };
}

/**
 * Everything the quota screens need, in three round trips.
 *
 * The quota row is read directly first rather than going straight to
 * `get_or_create_creator_quota`: the plain SELECT is covered by RLS
 * ("quotas_creator_own_read"), while the RPC is SECURITY DEFINER and writes.
 * The RPC is only reached on the one page load a month where the row does not
 * exist yet.
 * TODO(post-launch): the RPC takes p_creator_id and does not check it against
 * auth.uid(), so it will read or create a row for any creator id. Flagged to
 * the backend owner; this client only ever passes its own.
 */
export async function fetchCreatorQuota(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<{ snapshot: CreatorQuotaSnapshot | null; error: string | null }> {
  const monthKey = currentMonthKey();

  const [quotaResult, tiersResult] = await Promise.all([
    supabase
      .from('creator_content_quotas')
      .select('*')
      .eq('creator_id', creatorId)
      .eq('month_key', monthKey)
      .maybeSingle(),
    supabase.from('content_tier_limits').select('*').order('monthly_price_thb'),
  ]);

  if (quotaResult.error) {
    console.error('[creator/quota] quotas read failed', quotaResult.error);
    return { snapshot: null, error: READ_ERROR };
  }
  if (tiersResult.error || !tiersResult.data) {
    console.error('[creator/quota] tier limits read failed', tiersResult.error);
    return { snapshot: null, error: READ_ERROR };
  }

  let quotaRow = quotaResult.data as Record<string, unknown> | null;

  if (!quotaRow) {
    // First activity of the month: the row does not exist until something
    // creates it, and a creator who has not uploaded yet should still see
    // "0 / 5" rather than an error.
    const { data, error } = await supabase.rpc('get_or_create_creator_quota', {
      p_creator_id: creatorId,
    });
    if (error) {
      console.error('[creator/quota] get_or_create_creator_quota failed', error);
      return { snapshot: null, error: READ_ERROR };
    }
    quotaRow = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!quotaRow) return { snapshot: null, error: READ_ERROR };
  }

  const usage = toUsage(quotaRow);
  const allTiers = (tiersResult.data as Record<string, unknown>[]).map(toLimits);
  const limits = allTiers.find((row) => row.tier === usage.tier) ?? allTiers[0];

  if (!limits) {
    console.error('[creator/quota] content_tier_limits is empty');
    return { snapshot: null, error: READ_ERROR };
  }

  const { quota: liveQuota } = await fetchLiveQuota(supabase, creatorId);

  return {
    snapshot: { usage, limits, allTiers, live: toLiveDaily(liveQuota, limits) },
    error: null,
  };
}

function toLiveDaily(
  liveQuota: Awaited<ReturnType<typeof fetchLiveQuota>>['quota'],
  limits: TierLimits,
): LiveDailyUsage | null {
  if (!liveQuota) return null;

  // The RPC zeroes hours_remaining_today for three different refusals. Only
  // the daily-limit one actually means the day is spent.
  const dailyLimitHit = (liveQuota.reason ?? '').toLowerCase().includes('daily live limit');
  const known = liveQuota.canGolive || dailyLimitHit;

  return {
    hoursUsedToday: known
      ? Math.max(0, limits.maxLiveHoursPerDay - liveQuota.hoursRemainingToday)
      : 0,
    hoursLimitPerDay: limits.maxLiveHoursPerDay,
    known,
  };
}

/** 0-100, clamped. A zero or missing limit reads as full, not as divide-by-zero. */
export function usagePercent(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return used > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** How a usage bar should read. The thresholds are the sprint brief's. */
export type UsageState = 'ok' | 'warn' | 'high' | 'full';

export function usageState(percent: number): UsageState {
  if (percent >= 100) return 'full';
  if (percent > 85) return 'high';
  if (percent >= 60) return 'warn';
  return 'ok';
}

/**
 * Which wall a creator has hit. Named here rather than in the component that
 * renders it, so the upload page, the live page and the notice component all
 * agree on the vocabulary.
 */
export type QuotaBlockKind = 'videos' | 'storage' | 'live_hours' | 'account' | 'platform';

export interface QuotaBlock {
  kind: QuotaBlockKind;
  /** Thai, renderable. */
  title: string;
  /** Thai, renderable. */
  message: string;
  /** False where paying more would not help. */
  showUpgrade: boolean;
}

/** True when this creator cannot upload another video this month. */
export function isVideoQuotaFull(snapshot: CreatorQuotaSnapshot): boolean {
  return snapshot.usage.videosUploaded >= snapshot.limits.maxVideosPerMonth;
}

/** True when storage is full — the other refusal that blocks a new upload. */
export function isStorageFull(snapshot: CreatorQuotaSnapshot): boolean {
  return snapshot.usage.storageGb >= snapshot.limits.storageQuotaGb;
}

/** True when today's live allowance is spent. */
export function isLiveQuotaFull(snapshot: CreatorQuotaSnapshot): boolean {
  const live = snapshot.live;
  return live !== null && live.known && live.hoursUsedToday >= live.hoursLimitPerDay;
}

/**
 * True when the creator's own row has been throttled or suspended by the
 * backend, which refuses both uploads and live regardless of the counters.
 */
export function isAccountBlocked(snapshot: CreatorQuotaSnapshot): boolean {
  return snapshot.usage.status === 'throttled' || snapshot.usage.status === 'suspended';
}

/**
 * Why this creator cannot start an upload right now, or null if they can.
 *
 * Mirrors the order `check_creator_can_upload` checks in, so the reason shown
 * before the request is the reason the backend would have given after it. The
 * two length/feature refusals it also has (video too long, long-form on a free
 * tier) are deliberately not here: both depend on the file, which does not
 * exist yet at gate time, and the dropzone already reports them per file.
 */
export function describeUploadBlock(snapshot: CreatorQuotaSnapshot): QuotaBlock | null {
  if (isAccountBlocked(snapshot)) {
    return {
      kind: 'account',
      title: 'บัญชีของคุณถูกจำกัดการอัปโหลดชั่วคราว',
      message: 'กรุณาติดต่อทีมงานเพื่อตรวจสอบสถานะบัญชีของคุณ',
      showUpgrade: false,
    };
  }
  if (isVideoQuotaFull(snapshot)) {
    return {
      kind: 'videos',
      title: 'ครบโควตาวิดีโอเดือนนี้แล้ว',
      message:
        `คุณอัปโหลดครบ ${snapshot.limits.maxVideosPerMonth} คลิปของเดือนนี้แล้ว ` +
        `โควตาจะรีเซ็ตวันที่ ${nextMonthResetLabel()} หรืออัปเกรดแพ็กเกจเพื่ออัปโหลดต่อได้ทันที`,
      showUpgrade: true,
    };
  }
  if (isStorageFull(snapshot)) {
    return {
      kind: 'storage',
      title: 'พื้นที่จัดเก็บเต็มแล้ว',
      message:
        `คุณใช้พื้นที่ครบ ${formatGb(snapshot.limits.storageQuotaGb)} แล้ว ` +
        'ลบวิดีโอเก่าที่ไม่ใช้แล้วเพื่อคืนพื้นที่ หรืออัปเกรดแพ็กเกจ',
      showUpgrade: true,
    };
  }
  return null;
}

/** "2 GB", "0.4 GB". Storage figures are small enough to read in GB throughout. */
export function formatGb(value: number): string {
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} GB`;
}

/** "0.5 ชม.", "1.3 ชม." */
export function formatHours(value: number): string {
  return `${value.toFixed(1)} ชม.`;
}

/**
 * Thai date the monthly counters reset — the 1st of next month, Bangkok.
 *
 * Derived from currentMonthKey() rather than from the browser's clock: for
 * the seven hours a month when UTC and Bangkok disagree about which month it
 * is, the browser's month is the wrong one to add to.
 */
export function nextMonthResetLabel(): string {
  const [year, month] = currentMonthKey().split('-').map(Number);
  // Month is 1-based here and 0-based in Date.UTC, so `month` alone is
  // already the following month; noon avoids any tz rounding into the 31st.
  const next = new Date(Date.UTC(year, month, 1, 12));
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'long',
  }).format(next);
}
