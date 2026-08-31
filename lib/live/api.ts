'use client';

/**
 * Typed wrappers around the two deployed `live-*` Edge Functions, plus the
 * handful of direct `live_sessions` reads and writes the live screens need.
 *
 * The functions answer failures in the same envelope as the `content-*`
 * family —
 *
 *   { error: { message: 'Daily live limit reached (0.5/0.5 hours). ...',
 *              code: 'quota_exceeded' } }
 *
 * — nested one level deeper than the wallet functions and in English, because
 * the strings come out of `check_creator_can_golive` in Postgres. So this
 * module does the same two jobs lib/creator/api.ts does: read the nested
 * envelope, and map the outcome onto Thai copy the UI can render as-is. It is
 * not merged with that module because the failure vocabularies do not overlap
 * — nothing here is about Bunny, storage, or a monthly video count.
 */

import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import type { QuotaBlock } from '@/lib/creator/quota';
import type {
  CreateLiveRequest,
  CreateLiveResponse,
  EndLiveResponse,
  JoinLiveRequest,
  JoinLiveResponse,
  LiveQuota,
  LiveSessionDetail,
  LiveStatus,
} from './types';
import { DEFAULT_QUALITY, isBroadcastQuality } from './constants';

export interface LiveError {
  /** Machine-readable: the backend's `code`, or a local pseudo-code. */
  code: string;
  /** Thai, user-facing. Safe to render. */
  message: string;
  /** The backend's English text. Developer-facing only. */
  detail?: string | null;
  /** HTTP status; absent when the request never landed. */
  status?: number;
  /** True when the creator should be pointed at a plan upgrade. */
  quotaRelated?: boolean;
}

export interface LiveResult<T> {
  data: T | null;
  error: LiveError | null;
}

const NETWORK_ERROR: LiveError = {
  code: 'network_error',
  message: 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
  detail: 'Request did not reach the Edge Function',
};

const UNKNOWN_ERROR: LiveError = {
  code: 'internal_error',
  message: 'เกิดข้อผิดพลาด กรุณาลองใหม่',
  detail: 'Unparseable error response',
};

/** Thai, renderable. The screens show this verbatim. */
const READ_ERROR = 'โหลดข้อมูลไลฟ์ไม่สำเร็จ กรุณาลองใหม่';

/**
 * Thai per refusal from `check_creator_can_golive`.
 *
 * All three of its refusals arrive as the same `quota_exceeded` code and are
 * distinguishable only by their English sentence — the same stopgap, for the
 * same reason, as thaiForQuotaReason() in lib/creator/api.ts. An unrecognised
 * sentence falls back to the generic message, which is still true.
 * TODO(post-launch): ask backend for a distinct code per refusal.
 */
function thaiForGoliveReason(reason: string): { code: string; message: string } {
  const text = reason.toLowerCase();
  if (text.includes('budget')) {
    return {
      code: 'platform_budget',
      message: 'ระบบปิดไลฟ์ชั่วคราวเนื่องจากถึงขีดจำกัดค่าใช้จ่ายของแพลตฟอร์ม กรุณาลองใหม่ภายหลัง',
    };
  }
  if (text.includes('daily live limit')) {
    return {
      code: 'daily_limit',
      message: 'คุณใช้เวลาไลฟ์ครบโควตาของวันนี้แล้ว กรุณาลองใหม่พรุ่งนี้หรืออัปเกรดแพ็กเกจ',
    };
  }
  if (text.includes('throttled') || text.includes('suspended')) {
    return {
      code: 'account_throttled',
      message: 'บัญชีของคุณถูกจำกัดการไลฟ์ชั่วคราว กรุณาติดต่อทีมงาน',
    };
  }
  return {
    code: 'quota_exceeded',
    message: 'ยังเริ่มไลฟ์ไม่ได้ในขณะนี้ กรุณาตรวจสอบโควตาของแพ็กเกจคุณ',
  };
}

/** Codes for which the UI should surface the plan-upgrade hint. */
const QUOTA_CODES = new Set(['quota_exceeded', 'daily_limit']);

function thaiForLiveError(code: string, message: string, status: number): LiveError {
  // Code first, status second: both functions answer 403 for two unrelated
  // things (a creator over quota, and a viewer without an entitlement), and
  // reading the status first would report either as the other.
  if (code === 'quota_exceeded') {
    const mapped = thaiForGoliveReason(message);
    return {
      code: mapped.code,
      message: mapped.message,
      detail: message,
      status,
      quotaRelated: QUOTA_CODES.has(mapped.code),
    };
  }
  if (code === 'access_denied') {
    return {
      code,
      message: 'ไลฟ์นี้จำกัดสิทธิ์การเข้าชม',
      detail: message,
      status,
    };
  }
  if (code === 'not_active') {
    return { code, message: 'ไลฟ์นี้จบแล้ว', detail: message, status };
  }
  if (status === 401) {
    return {
      code: 'unauthenticated',
      // The 401 has two causes — an expired session, and a signed-in user with
      // no `creators` row (getAuthedCreator returns null for both). The
      // creator gate on /creator/live rules the second one out before this
      // call is ever made, so "session expired" is the honest reading here.
      message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
      detail: message,
      status,
    };
  }
  if (status === 403) {
    return { code: code || 'forbidden', message: 'คุณไม่มีสิทธิ์ทำรายการนี้', detail: message, status };
  }
  if (status === 404) {
    return { code: 'not_found', message: 'ไม่พบไลฟ์นี้', detail: message, status };
  }
  return { ...UNKNOWN_ERROR, code: code || UNKNOWN_ERROR.code, detail: message, status };
}

async function parseHttpError(response: Response): Promise<LiveError> {
  try {
    const body = await response.json();
    const envelope = body?.error;
    if (envelope && typeof envelope === 'object' && typeof envelope.message === 'string') {
      return thaiForLiveError(
        typeof envelope.code === 'string' ? envelope.code : '',
        envelope.message,
        response.status,
      );
    }
  } catch {
    // An HTML error page from the platform rather than a function response.
  }
  return { ...UNKNOWN_ERROR, status: response.status };
}

/** Never throws: every failure comes back as `error`. */
async function invokeLive<T>(
  supabase: SupabaseClient,
  name: string,
  body: Record<string, unknown>,
): Promise<LiveResult<T>> {
  try {
    const { data, error } = await supabase.functions.invoke<T>(name, { method: 'POST', body });

    if (error) {
      if (error instanceof FunctionsHttpError && error.context instanceof Response) {
        return { data: null, error: await parseHttpError(error.context) };
      }
      return { data: null, error: { ...NETWORK_ERROR, detail: error.message } };
    }
    return { data: data ?? null, error: null };
  } catch (err) {
    console.error(`[live/api] ${name} failed`, err);
    return { data: null, error: NETWORK_ERROR };
  }
}

/**
 * Create the session and mint a publisher token.
 *
 * The row exists from the moment this resolves, with status 'waiting' and
 * started_at already set — so the clock the summary bills against starts
 * HERE, not when LiveKit connects. A creator who abandons the page between
 * the two leaves a 'waiting' row that only live-end-session can close.
 * TODO(post-launch): a reaper for sessions that never reached 'live'.
 */
export function createLiveSession(
  supabase: SupabaseClient,
  payload: Omit<CreateLiveRequest, 'mode'>,
): Promise<LiveResult<CreateLiveResponse>> {
  return invokeLive<CreateLiveResponse>(supabase, 'live-create-session', {
    ...payload,
    mode: 'create',
  });
}

/** Mint a subscriber token for a session that is 'waiting' or 'live'. */
export function joinLiveSession(
  supabase: SupabaseClient,
  payload: Omit<JoinLiveRequest, 'mode'>,
): Promise<LiveResult<JoinLiveResponse>> {
  return invokeLive<JoinLiveResponse>(supabase, 'live-create-session', {
    ...payload,
    mode: 'join',
  });
}

/**
 * Close the session and get the analytics summary.
 *
 * `save_recording` is deliberately not sent: LiveKit egress is not wired, and
 * the function answers `recording: { status: 'not_implemented' }` when asked
 * — a promise the platform cannot keep. Recording is post-launch.
 */
export function endLiveSession(
  supabase: SupabaseClient,
  liveSessionId: string,
): Promise<LiveResult<EndLiveResponse>> {
  return invokeLive<EndLiveResponse>(supabase, 'live-end-session', {
    live_session_id: liveSessionId,
  });
}

/**
 * The creator's live ceiling, read before the form is filled in rather than
 * discovered from a rejected go-live.
 *
 * `check_creator_can_golive` is SECURITY DEFINER and granted to
 * `authenticated`, so this is one round trip with no Edge Function in front
 * of it. The same RPC runs again inside live-create-session, which stays the
 * authority — drift here costs a confusing form, never a bad row.
 */
export async function fetchLiveQuota(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<{ quota: LiveQuota | null; error: string | null }> {
  const { data, error } = await supabase.rpc('check_creator_can_golive', {
    p_creator_id: creatorId,
  });

  if (error) {
    console.error('[live/api] check_creator_can_golive failed', error);
    return { quota: null, error: READ_ERROR };
  }

  // The function RETURNS TABLE, so PostgREST hands back an array of one row.
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return { quota: null, error: READ_ERROR };

  const quality = row.max_quality;
  return {
    quota: {
      canGolive: row.can_golive === true,
      reason: typeof row.reason === 'string' ? row.reason : null,
      maxQuality: isBroadcastQuality(quality) ? quality : DEFAULT_QUALITY,
      maxViewers: typeof row.max_viewers === 'number' ? row.max_viewers : 0,
      // numeric comes back as a string over PostgREST; Number() covers both.
      hoursRemainingToday: Number(row.hours_remaining_today ?? 0),
    },
    error: null,
  };
}

/**
 * A refusal read from the RPC rather than from a 403, shaped for the
 * full-page blocked state on /creator/live.
 *
 * The three reasons want three different pages: a spent daily allowance is
 * answered by upgrading, a kill switch is answered by waiting, and a
 * throttled account is answered by talking to us. Offering "อัปเกรดแพ็กเกจ"
 * for the last two would be selling a plan that does not fix the problem.
 *
 * QuotaBlock is imported as a type only, so this does not create a runtime
 * cycle with lib/creator/quota.ts (which imports fetchLiveQuota from here).
 */
export function describeGoliveBlock(quota: LiveQuota): QuotaBlock | null {
  if (quota.canGolive) return null;

  const mapped = thaiForGoliveReason(quota.reason ?? '');

  if (mapped.code === 'platform_budget') {
    return {
      kind: 'platform',
      title: 'ระบบไม่รับไลฟ์ใหม่ชั่วคราว',
      message: mapped.message,
      showUpgrade: false,
    };
  }
  if (mapped.code === 'account_throttled') {
    return {
      kind: 'account',
      title: 'บัญชีของคุณถูกจำกัดการไลฟ์ชั่วคราว',
      message: mapped.message,
      showUpgrade: false,
    };
  }
  return {
    kind: 'live_hours',
    title: mapped.code === 'daily_limit' ? 'ครบโควตาไลฟ์ของวันนี้แล้ว' : 'ยังเริ่มไลฟ์ไม่ได้ในขณะนี้',
    message: mapped.message,
    showUpgrade: true,
  };
}

const SESSION_COLUMNS =
  'id, creator_id, room_name, title, description, cover_image_url, access_level, ' +
  'ppv_price_stars, status, current_viewer_count, peak_viewer_count, ' +
  'tip_stars_received, started_at, ended_at, broadcast_quality';

function toSessionDetail(row: Record<string, unknown>): LiveSessionDetail {
  const quality = row.broadcast_quality;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '' ? value : null;

  return {
    id: String(row.id),
    creator_id: String(row.creator_id),
    room_name: String(row.room_name),
    title: String(row.title ?? ''),
    description: text(row.description),
    cover_image_url: text(row.cover_image_url),
    access_level: row.access_level as LiveSessionDetail['access_level'],
    ppv_price_stars: typeof row.ppv_price_stars === 'number' ? row.ppv_price_stars : null,
    status: row.status as LiveStatus,
    current_viewer_count: count(row.current_viewer_count),
    peak_viewer_count: count(row.peak_viewer_count),
    tip_stars_received: count(row.tip_stars_received),
    started_at: text(row.started_at),
    ended_at: text(row.ended_at),
    broadcast_quality: isBroadcastQuality(quality) ? quality : null,
  };
}

/**
 * One session's metadata, for the watch page.
 *
 * `notFound` does NOT mean the session does not exist. The live policies are
 *
 *   live_sessions_public_active_read  status IN (live, waiting, scheduled,
 *                                      ended) AND access_level = 'public'
 *   live_sessions_subscriber_read     access_level = 'subscribers' AND an
 *                                      active subscription exists
 *   live_sessions_creator_own_read    the creator's own rows
 *
 * — so a 'ppv' session, and a 'subscribers' session seen by a non-subscriber,
 * have no readable row at all. maybeSingle() rather than single(): that is the
 * expected outcome for a locked session, and single() turns it into a thrown
 * error. The watch page resolves the ambiguity by asking the join function,
 * which runs as the service role and sees every row.
 */
export async function fetchLiveSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<{ session: LiveSessionDetail | null; notFound: boolean; error: string | null }> {
  const { data, error } = await supabase
    .from('live_sessions')
    .select(SESSION_COLUMNS)
    .eq('id', sessionId)
    .maybeSingle();

  if (error) {
    console.error('[live/api] live_sessions read failed', error);
    return { session: null, notFound: false, error: READ_ERROR };
  }
  if (!data) return { session: null, notFound: true, error: null };

  return {
    session: toSessionDetail(data as unknown as Record<string, unknown>),
    notFound: false,
    error: null,
  };
}

/**
 * Promote the row to status 'live' once the publisher is actually connected.
 *
 * The backend inserts it as 'waiting' and nothing else ever moves it, so
 * without this a session is on air with a row that says it is not — which is
 * what /discover and the dashboard strip read. The creator owns the row
 * (`live_sessions_creator_own_write`), so this is a legal write for exactly
 * the one person entitled to make it.
 *
 * Best-effort: a refusal is logged and swallowed. Being unlisted for a few
 * minutes is worth less than interrupting a broadcast that is already running,
 * and the feed query accepts 'waiting' too, so the session stays discoverable
 * either way.
 * TODO(post-launch): move this to a LiveKit `room_started` webhook, which
 * observes the room rather than trusting the broadcaster's browser.
 */
export async function markSessionLive(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  const { error } = await supabase
    .from('live_sessions')
    .update({ status: 'live', updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('status', 'waiting');

  if (error) console.error('[live/api] markSessionLive failed', error);
}

/**
 * Write the viewer counts LiveKit reports back to the row.
 *
 * Two things depend on this and nothing else provides them:
 *
 *  - `peak_viewer_count` has no writer anywhere in the backend, and
 *    live-end-session READS it to build the session summary. Without this
 *    write every summary reports a peak of 0.
 *  - `current_viewer_count` is only ever incremented, by the join function,
 *    and never decremented, so the number on the discover card climbs forever
 *    as viewers come and go.
 *
 * The broadcaster is the one participant that knows the true count, so it is
 * the one that writes it. `peak` is raised, never lowered, so a slow write
 * cannot walk the maximum backwards.
 *
 * Best-effort for the same reason as markSessionLive: an inaccurate count is
 * not worth a broken broadcast.
 */
export async function persistViewerCounts(
  supabase: SupabaseClient,
  sessionId: string,
  current: number,
  peak: number,
): Promise<void> {
  const { error } = await supabase
    .from('live_sessions')
    .update({
      current_viewer_count: current,
      peak_viewer_count: peak,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)
    // Never lower a stored peak, and never touch a session that has already
    // been closed — a write still in flight when "จบไลฟ์" lands would
    // otherwise put a live viewer count back on an ended row.
    .lte('peak_viewer_count', peak)
    .in('status', ['waiting', 'live']);

  if (error) console.error('[live/api] persistViewerCounts failed', error);
}

/**
 * Which lock a 403 `access_denied` is about.
 *
 * The join function does not return the access_level, only one of two English
 * sentences ('Pay to unlock this live' / 'Subscribe to watch'), and for a
 * locked session RLS hides the row that would otherwise say. Matching on the
 * sentence is a stopgap, not a contract — an unrecognised one falls back to
 * the subscribers lock, which is the commoner of the two and never invites
 * anyone to pay for something by mistake.
 * TODO(post-launch): ask backend to include access_level in the 403 body.
 */
export function lockLevelFromMessage(message: string | null | undefined): 'subscribers' | 'ppv' {
  return (message ?? '').toLowerCase().includes('pay to unlock') ? 'ppv' : 'subscribers';
}
