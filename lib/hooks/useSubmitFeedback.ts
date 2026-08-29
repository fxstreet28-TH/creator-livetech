'use client';

/**
 * Submits one feedback message to the `send-feedback` Edge Function.
 *
 * Why this does not go through `lib/wallet/invoke.ts`: that helper normalises
 * the wallet functions, which answer every refusal with the `_shared/errors.ts`
 * shape `{ error, message, detail }` where `message` is Thai and ready to
 * render. send-feedback predates that convention and answers
 * `{ error, detail }` — no `message`, and `detail` is English debugging text
 * ("Max 5 submissions per hour"). Handed to invokeEdge, every one of those
 * bodies fails its `typeof body.message === 'string'` check and collapses into
 * the generic UNKNOWN_ERROR, throwing away the `error` code the widget has to
 * branch on. So the parsing lives here, and the Thai copy is written here too.
 *
 * The access token is not passed by hand: supabase.functions.invoke() attaches
 * the current session's bearer token itself, refreshing it first if it is
 * about to expire, which is exactly what the function's verify_jwt requires.
 */

import { useCallback, useState } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import type { FeedbackCategory } from '@/lib/feedback/categories';

const FUNCTION_NAME = 'send-feedback';

export interface FeedbackPayload {
  category: FeedbackCategory;
  message: string;
  /** 1-5, omitted entirely when the user skipped the stars. */
  rating?: number;
}

export interface FeedbackSuccess {
  success: true;
  feedback_id: string;
  /** Whether the notification email went out. The submission is stored either way. */
  email: 'sent' | 'failed' | 'skipped_no_api_key';
  resend_id?: string | null;
}

export interface FeedbackError {
  /** Machine-readable code from the function, or a local pseudo-code. */
  code: string;
  /** Thai, user-facing. Localised here — the function does not send one. */
  message: string;
  /** HTTP status. Absent when the request never reached the function. */
  status?: number;
  /** True when the same call could plausibly succeed on a second try. */
  retryable: boolean;
}

/**
 * Thai copy per failure the user can actually reach.
 *
 * The 400s are all mirrored by client-side validation, so a user should never
 * see them; they are here because "should never" is not "cannot" — a category
 * id drifting out of sync with the function would otherwise surface as a
 * blank failure.
 */
const MESSAGE_BY_CODE: Record<string, string> = {
  invalid_category: 'ประเภทความคิดเห็นไม่ถูกต้อง',
  message_too_short: 'ข้อความสั้นเกินไป กรุณาพิมพ์อย่างน้อย 5 ตัวอักษร',
  message_too_long: 'ข้อความยาวเกินไป กรุณาพิมพ์ไม่เกิน 5,000 ตัวอักษร',
  invalid_rating: 'คะแนนไม่ถูกต้อง',
  invalid_json: 'เกิดข้อผิดพลาด กรุณาลองใหม่',
  unauthorized: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  invalid_session: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  rate_limit_exceeded: 'คุณส่งความคิดเห็นเข้ามาบ่อยเกินไป กรุณาลองใหม่ภายหลัง',
  insert_failed: 'ส่งไม่สำเร็จ กรุณาลองใหม่',
};

const GENERIC_MESSAGE = 'ส่งไม่สำเร็จ กรุณาลองใหม่';

const NETWORK_ERROR: FeedbackError = {
  code: 'network_error',
  message: 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
  retryable: true,
};

/**
 * 5xx and network failures can change their answer on a retry. A 400 is the
 * message the user typed and a 429 is a clock that has not run out yet —
 * offering "try again" for either would be a lie.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

async function parseErrorResponse(response: Response): Promise<FeedbackError> {
  let code = 'internal_error';
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      code = (body as { error: string }).error;
    }
  } catch {
    // An HTML error page or an empty body from the platform rather than from
    // the function. Keep the status, fall back to the generic message.
  }
  return {
    code,
    message: MESSAGE_BY_CODE[code] ?? GENERIC_MESSAGE,
    status: response.status,
    retryable: isRetryableStatus(response.status),
  };
}

export interface UseSubmitFeedback {
  submit: (payload: FeedbackPayload) => Promise<FeedbackSuccess | null>;
  submitting: boolean;
  error: FeedbackError | null;
  clearError: () => void;
}

export function useSubmitFeedback(): UseSubmitFeedback {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const submit = useCallback(async (payload: FeedbackPayload): Promise<FeedbackSuccess | null> => {
    setSubmitting(true);
    setError(null);

    const fail = (next: FeedbackError) => {
      setError(next);
      setSubmitting(false);
      return null;
    };

    try {
      const supabase = getBrowserSupabase();
      const { data, error: invokeError } = await supabase.functions.invoke<FeedbackSuccess>(
        FUNCTION_NAME,
        {
          body: {
            ...payload,
            // Recommended, not required: it is the difference between "the
            // buy-stars form is broken" and a bug report you have to reply to
            // in order to find out which screen it was about.
            page_url: window.location.href,
          },
        },
      );

      if (invokeError) {
        if (invokeError instanceof FunctionsHttpError && invokeError.context instanceof Response) {
          return fail(await parseErrorResponse(invokeError.context));
        }
        // FunctionsFetchError / FunctionsRelayError — offline, DNS, CORS, or
        // the relay could not run the function at all.
        return fail(NETWORK_ERROR);
      }

      if (!data?.success) {
        return fail({ code: 'internal_error', message: GENERIC_MESSAGE, retryable: true });
      }

      setSubmitting(false);
      return data;
    } catch (err) {
      // getBrowserSupabase() throws synchronously when the Supabase env vars
      // are missing, and invoke() rejects rather than resolves when the fetch
      // itself throws.
      console.error('[useSubmitFeedback] send-feedback failed', err);
      return fail(NETWORK_ERROR);
    }
  }, []);

  return { submit, submitting, error, clearError };
}
