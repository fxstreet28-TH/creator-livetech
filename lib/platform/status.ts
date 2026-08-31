'use client';

/**
 * The platform budget kill switch, as the frontend sees it.
 *
 * `platform_budget_state` holds the month's spend against the cap and the
 * thresholds that move `status` through normal → warning → degraded →
 * emergency → readonly. That table is service-role only, and rightly so: it
 * carries what the platform has spent in baht, which is nobody's business but
 * ours (non-negotiable #6).
 *
 * `platform_status_public` is the view that exists for this client. It exposes
 * four columns — month_key, status, status_changed_at, and a Thai sentence per
 * status — filtered to the current Bangkok month, and grants SELECT to anon
 * and authenticated. No number ever reaches the browser.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QuotaBlock } from '@/lib/creator/quota';

/** platform_budget_state.status CHECK, in escalation order. */
export type PlatformStatusName = 'normal' | 'warning' | 'degraded' | 'emergency' | 'readonly';

export interface PlatformStatus {
  month_key: string;
  status: PlatformStatusName;
  status_changed_at: string | null;
  /** Thai, from the view's CASE. Null for a status the view has no copy for. */
  status_message_th: string | null;
}

/**
 * How often the banner re-reads the view.
 *
 * Polling rather than Realtime: `platform_budget_state` is not in the
 * `supabase_realtime` publication (only `stars_wallet` and `messages` are), so
 * a subscription would connect and then never fire — the same trap
 * ENCODING_POLL_MS documents for feed_posts. A minute is far finer than the
 * status actually moves; it exists so a creator mid-session finds out without
 * reloading.
 */
export const PLATFORM_STATUS_POLL_MS = 60_000;

const STATUS_NAMES: PlatformStatusName[] = [
  'normal',
  'warning',
  'degraded',
  'emergency',
  'readonly',
];

function isStatusName(value: unknown): value is PlatformStatusName {
  return typeof value === 'string' && (STATUS_NAMES as string[]).includes(value);
}

/**
 * Read the current status, or null if it cannot be established.
 *
 * Null covers three cases that all mean the same thing to a caller — the read
 * failed, the view is unreachable, or there is no row for this month yet
 * (which happens on the 1st, before the budget job writes one). Every caller
 * treats null as "carry on": a platform that cannot tell us it is in trouble
 * is not grounds for showing every user a banner, and the backend refuses the
 * dangerous operations on its own regardless.
 */
export async function fetchPlatformStatus(
  supabase: SupabaseClient,
): Promise<PlatformStatus | null> {
  const { data, error } = await supabase.from('platform_status_public').select('*').maybeSingle();

  if (error) {
    console.error('[platform/status] platform_status_public read failed', error);
    return null;
  }
  if (!data) return null;

  const row = data as Record<string, unknown>;
  if (!isStatusName(row.status)) return null;

  return {
    month_key: String(row.month_key ?? ''),
    status: row.status,
    status_changed_at: typeof row.status_changed_at === 'string' ? row.status_changed_at : null,
    status_message_th:
      typeof row.status_message_th === 'string' && row.status_message_th.trim() !== ''
        ? row.status_message_th
        : null,
  };
}

/** Anything but 'normal' puts a banner on screen. */
export function shouldShowBanner(status: PlatformStatus | null): boolean {
  return status !== null && status.status !== 'normal';
}

/**
 * True when the platform is not accepting new uploads or new broadcasts.
 *
 * Matches `check_creator_can_upload` and `check_creator_can_golive`, which
 * both refuse on exactly these two statuses. Keeping the same pair in one
 * place is what stops the UI from blocking something the backend allows, or
 * — worse — inviting someone into a flow that 403s at the end.
 */
export function blocksNewContent(status: PlatformStatus | null): boolean {
  return status?.status === 'emergency' || status?.status === 'readonly';
}

/** True in the one state that degrades quality instead of refusing work. */
export function isDegraded(status: PlatformStatus | null): boolean {
  return status?.status === 'degraded';
}

/**
 * The blocked state for a creator screen while the platform is not accepting
 * new work, or null when it is.
 *
 * Shares QuotaBlock with the quota gates so both reasons render through the
 * same component: from the creator's side "I cannot upload right now" is one
 * situation with two causes, and two differently-shaped cards for it would be
 * two things to recognise. `showUpgrade` is false — no plan fixes a platform
 * that has hit its own cap, and offering one here would be selling something
 * that does not help.
 */
export function describePlatformBlock(
  status: PlatformStatus | null,
  surface: 'upload' | 'live',
): QuotaBlock | null {
  if (!status || !blocksNewContent(status)) return null;

  return {
    kind: 'platform',
    title: surface === 'upload' ? 'ระบบไม่รับอัปโหลดใหม่ชั่วคราว' : 'ระบบไม่รับไลฟ์ใหม่ชั่วคราว',
    message: `${platformStatusMessage(status)} — เนื้อหาที่เผยแพร่แล้วยังดูได้ตามปกติ กรุณาลองใหม่อีกครั้งภายหลัง`,
    showUpgrade: false,
  };
}

/**
 * What to render for a status. Prefers the view's own Thai sentence so ops can
 * reword an incident message in SQL without a deploy; the fallback only fires
 * for a status the view's CASE does not cover.
 */
export function platformStatusMessage(status: PlatformStatus): string {
  return status.status_message_th ?? `แพลตฟอร์มอยู่ในสถานะ ${status.status}`;
}
