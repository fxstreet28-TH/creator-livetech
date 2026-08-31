'use client';

/**
 * Typed wrappers around the deployed `content-*` Edge Functions.
 *
 * Why this exists rather than lib/wallet/invoke.ts: the two function families
 * answer failures in different shapes. The wallet functions use
 * _shared/errors.ts —
 *
 *   { error: 'wallet_cap_exceeded', message: 'ยอด stars ...', detail: ... }
 *
 * — with the user-facing sentence already in Thai. The content functions use a
 * different _shared/utils.ts —
 *
 *   { error: { message: 'Monthly video quota reached (5/5). ...', code: 'quota_exceeded' } }
 *
 * — nested one level deeper, and in English, because the strings come out of
 * `check_creator_can_upload` in Postgres. So this module does two jobs the
 * wallet wrapper does not: it reads the nested envelope, and it maps the
 * outcome onto Thai copy the UI can render as-is. The English original is kept
 * on `detail` for console.error only, never for the screen.
 */

import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import type {
  PlaybackUrlResponse,
  UploadRequestPayload,
  UploadRequestResponse,
} from './types';

export interface ContentError {
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

export interface ContentResult<T> {
  data: T | null;
  error: ContentError | null;
}

const NETWORK_ERROR: ContentError = {
  code: 'network_error',
  message: 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
  detail: 'Request did not reach the Edge Function',
};

const UNKNOWN_ERROR: ContentError = {
  code: 'internal_error',
  message: 'เกิดข้อผิดพลาด กรุณาลองใหม่',
  detail: 'Unparseable error response',
};

/**
 * Thai copy per backend refusal.
 *
 * `quota_exceeded` covers five different refusals in
 * `check_creator_can_upload` — monthly count, video length, long-form not
 * available on this tier, storage, and the platform budget kill switch — and
 * they arrive indistinguishable except by their English sentence, since
 * errorResponse() drops `quota_details`. Matching on that sentence is a
 * stopgap, not a contract: an unrecognised one falls back to the generic quota
 * message, which is still true.
 * TODO(day-9): ask backend to return a distinct code per refusal.
 */
function thaiForQuotaReason(reason: string): { message: string; code: string } {
  const text = reason.toLowerCase();
  if (text.includes('platform budget')) {
    return {
      code: 'platform_budget',
      message: 'ระบบปิดรับอัปโหลดชั่วคราวเนื่องจากถึงขีดจำกัดค่าใช้จ่ายของแพลตฟอร์ม กรุณาลองใหม่ภายหลัง',
    };
  }
  if (text.includes('too long')) {
    return {
      code: 'duration_exceeded',
      message: 'วิดีโอยาวเกินกว่าที่แพ็กเกจของคุณรองรับ กรุณาตัดให้สั้นลงหรืออัปเกรดแพ็กเกจ',
    };
  }
  if (text.includes('long-form')) {
    return {
      code: 'long_form_not_allowed',
      message: 'แพ็กเกจปัจจุบันอัปโหลดได้เฉพาะวิดีโอสั้น (ไม่เกิน 1 นาที) กรุณาอัปเกรดแพ็กเกจเพื่ออัปโหลดวิดีโอยาว',
    };
  }
  if (text.includes('storage')) {
    return {
      code: 'storage_exceeded',
      message: 'พื้นที่จัดเก็บเต็มแล้ว กรุณาลบวิดีโอเก่าหรืออัปเกรดแพ็กเกจ',
    };
  }
  if (text.includes('quota') || text.includes('suspended') || text.includes('throttled')) {
    return {
      code: 'quota_exceeded',
      message: 'คุณอัปโหลดครบโควตาของเดือนนี้แล้ว กรุณารอเดือนถัดไปหรืออัปเกรดแพ็กเกจ',
    };
  }
  return {
    code: 'quota_exceeded',
    message: 'ยังอัปโหลดไม่ได้ในขณะนี้ กรุณาตรวจสอบโควตาของแพ็กเกจคุณ',
  };
}

/** Codes for which the UI should surface the plan-upgrade link. */
const QUOTA_CODES = new Set([
  'quota_exceeded',
  'duration_exceeded',
  'long_form_not_allowed',
  'storage_exceeded',
]);

function thaiForError(code: string, message: string, status: number): ContentError {
  // Code-specific branches first: content-get-playback-url answers both
  // 'not_published' and an un-entitled viewer with 403, and reading the status
  // before the code would report either as a quota problem.
  if (code === 'video_not_ready') {
    return {
      code,
      message: 'วิดีโอยังประมวลผลไม่เสร็จ กรุณารอสักครู่',
      detail: message,
      status,
    };
  }
  if (code === 'not_published') {
    return {
      code,
      message: 'โพสต์นี้ยังไม่ถูกเผยแพร่',
      detail: message,
      status,
    };
  }
  if (code === 'bunny_error' || status === 502) {
    return {
      code: 'bunny_error',
      message: 'ระบบวิดีโอไม่ตอบสนอง กรุณาลองใหม่อีกครั้ง',
      detail: message,
      status,
    };
  }
  if (code === 'quota_exceeded' || status === 403) {
    const mapped = thaiForQuotaReason(message);
    return {
      code: mapped.code,
      message: mapped.message,
      detail: message,
      status,
      quotaRelated: QUOTA_CODES.has(mapped.code),
    };
  }
  if (status === 401) {
    return {
      code: 'unauthenticated',
      message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
      detail: message,
      status,
    };
  }
  if (status === 404) {
    return { code: 'not_found', message: 'ไม่พบโพสต์นี้', detail: message, status };
  }
  return { ...UNKNOWN_ERROR, detail: message, status };
}

async function parseHttpError(response: Response): Promise<ContentError> {
  try {
    const body = await response.json();
    const envelope = body?.error;
    if (envelope && typeof envelope === 'object' && typeof envelope.message === 'string') {
      return thaiForError(
        typeof envelope.code === 'string' ? envelope.code : 'error',
        envelope.message,
        response.status,
      );
    }
    // content-get-playback-url answers an un-entitled viewer with a 403 that
    // is NOT the error envelope. A creator reading their own post never sees
    // it, but a wrong post_id would.
    if (body && body.has_access === false) {
      return {
        code: 'no_access',
        message: 'คุณไม่มีสิทธิ์เข้าถึงวิดีโอนี้',
        detail: typeof body.message === 'string' ? body.message : null,
        status: response.status,
      };
    }
  } catch {
    // An HTML error page from the platform rather than a function response.
  }
  return { ...UNKNOWN_ERROR, status: response.status };
}

/** Never throws: every failure comes back as `error`. */
async function invokeContent<T>(
  supabase: SupabaseClient,
  name: string,
  body: Record<string, unknown>,
): Promise<ContentResult<T>> {
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
    console.error(`[creator/api] ${name} failed`, err);
    return { data: null, error: NETWORK_ERROR };
  }
}

/**
 * Reserve a Bunny Stream slot and create the draft feed_posts row.
 *
 * The response carries a per-video upload signature — see the SECURITY note
 * on UploadRequestResponse.tus_headers. Do not log the resolved value.
 */
export function requestVideoUpload(
  supabase: SupabaseClient,
  payload: UploadRequestPayload,
): Promise<ContentResult<UploadRequestResponse>> {
  return invokeContent<UploadRequestResponse>(
    supabase,
    'content-request-video-upload',
    payload as unknown as Record<string, unknown>,
  );
}

/**
 * HLS URL for a post. A creator is entitled to their own content, so this is
 * the same call the viewer flow will make on Day 5-6.
 *
 * Note the side effect: the backend increments view_count on every successful
 * call, so a creator previewing their own post inflates it. Backend concern,
 * flagged rather than worked around here.
 */
export function getPlaybackUrl(
  supabase: SupabaseClient,
  postId: string,
): Promise<ContentResult<PlaybackUrlResponse>> {
  return invokeContent<PlaybackUrlResponse>(supabase, 'content-get-playback-url', {
    post_id: postId,
  });
}
