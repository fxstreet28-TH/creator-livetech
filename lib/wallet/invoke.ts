'use client';

/**
 * Thin wrapper over supabase.functions.invoke() for the wallet Edge Functions.
 *
 * Exists because supabase-js throws away the thing these endpoints exist to
 * return. Every wallet function answers a refusal with a JSON body shaped by
 * _shared/errors.ts —
 *
 *   { error: 'wallet_cap_exceeded', message: 'ยอด stars ในกระเป๋าจะเกินขีดจำกัด', detail: ... }
 *
 * — and on any non-2xx, invoke() rejects with a FunctionsHttpError whose
 * `message` is the generic "Edge Function returned a non-2xx status code".
 * The Thai sentence the user needs is in the unread Response hanging off
 * `error.context`. Rendering `error.message` straight to the screen, which is
 * the obvious thing to do, therefore shows every failure as the same English
 * string; reading the body is the only way to get the backend's own copy.
 *
 * So: one place parses that body, and callers get { code, message } they can
 * render or switch on.
 */

import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';

export interface EdgeError {
  /** Machine-readable code from _shared/errors.ts, or a local pseudo-code. */
  code: string;
  /** Thai, user-facing. Already localised by the backend — render as-is. */
  message: string;
  /** English debugging hint. Never shown to users. */
  detail?: string | null;
  /** HTTP status, absent for network failures. */
  status?: number;
}

export interface EdgeResult<T> {
  data: T | null;
  error: EdgeError | null;
}

/** Network failure, offline, DNS — the request never reached the function. */
const NETWORK_ERROR: EdgeError = {
  code: 'network_error',
  message: 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
  detail: 'Request did not reach the Edge Function',
};

/** The function answered, but not with a shape errors.ts would produce. */
const UNKNOWN_ERROR: EdgeError = {
  code: 'internal_error',
  message: 'เกิดข้อผิดพลาด กรุณาลองใหม่',
  detail: 'Unparseable error response',
};

/**
 * True for statuses worth a retry. 4xx are the user's input or their wallet
 * state and will fail identically on a second call; 5xx and network failures
 * are the ones where trying again can legitimately change the answer.
 *
 * Exported because the buyback form retries on this and the buy form
 * deliberately does not — an automatic retry of create-payment-intent would
 * open a second PaymentIntent and leave an orphan for the first.
 */
export function isRetryable(error: EdgeError | null): boolean {
  if (!error) return false;
  if (error.code === 'network_error') return true;
  return typeof error.status === 'number' && error.status >= 500;
}

async function parseHttpError(response: Response): Promise<EdgeError> {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string' && typeof body.message === 'string') {
      return {
        code: body.error,
        message: body.message,
        detail: typeof body.detail === 'string' ? body.detail : null,
        status: response.status,
      };
    }
  } catch {
    // Fall through — an HTML error page or an empty body from the platform
    // rather than from the function.
  }
  return { ...UNKNOWN_ERROR, status: response.status };
}

/**
 * Invoke a wallet Edge Function and normalise the outcome.
 *
 * Never throws: every failure comes back as `error`, so callers write one
 * branch instead of a try/catch plus a branch.
 */
export async function invokeEdge<T>(
  supabase: SupabaseClient,
  name: string,
  options?: { body?: Record<string, unknown>; method?: 'GET' | 'POST' },
): Promise<EdgeResult<T>> {
  try {
    const { data, error } = await supabase.functions.invoke<T>(name, {
      method: options?.method ?? 'POST',
      ...(options?.body !== undefined ? { body: options.body } : {}),
    });

    if (error) {
      if (error instanceof FunctionsHttpError && error.context instanceof Response) {
        return { data: null, error: await parseHttpError(error.context) };
      }
      // FunctionsFetchError / FunctionsRelayError — the function was never
      // reached, or the relay could not run it.
      return { data: null, error: { ...NETWORK_ERROR, detail: error.message } };
    }

    return { data: data ?? null, error: null };
  } catch (err) {
    // invoke() rejects rather than resolves when the fetch itself throws.
    console.error(`[invokeEdge] ${name} failed`, err);
    return { data: null, error: NETWORK_ERROR };
  }
}
