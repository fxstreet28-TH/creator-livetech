'use client';

/**
 * Thin client-side wrapper around the signup backend. `initSignup` and `resend`
 * call Supabase Edge Functions; `completeSignup` is still the Vercel route
 * until PR 5c. Each method returns a discriminated result so step components
 * can drive their own loading/error UI.
 */

import { apiUrl } from '@/lib/config';
import { normalizePhoneE164 } from '@/lib/phone';
import { getBrowserSupabase } from '@/lib/supabase-browser';

export interface InitResult {
  ok: boolean;
  status: number;
  sessionId?: string;
  phoneMasked?: string;
  emailMasked?: string;
  smsSent?: boolean;
  emailSent?: boolean;
  error?: string;
  reason?: string;
  retryAfterSeconds?: number;
}

export interface CompleteResult {
  ok: boolean;
  status: number;
  accessToken?: string;
  refreshToken?: string;
  smsInvalid?: boolean;
  emailInvalid?: boolean;
  error?: string;
}

export interface ResendResult {
  ok: boolean;
  status: number;
  error?: string;
  retryAfterSeconds?: number;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Calls an Edge Function and flattens the result back into the `{ status, data }`
 * pair the callers below were written against.
 *
 * `functions.invoke()` throws a `FunctionsHttpError` for any non-2xx reply, so
 * the status and the JSON error body — which Step1Credentials maps to Thai copy
 * and Step2Verify branches on (429 -> cooldown countdown) — have to be read off
 * the raw `response` it hands back. On success the SDK has already consumed the
 * body, so `data` is used there instead. A network failure has no HTTP status;
 * status 0 keeps callers on their generic-error path.
 */
async function invokeFunction(
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const supabase = getBrowserSupabase();
  const { data, error, response } = await supabase.functions.invoke(name, { body });

  if (!error) {
    return { status: response?.status ?? 200, data: (data ?? {}) as Record<string, unknown> };
  }
  if (response) {
    return { status: response.status, data: await readJson(response) };
  }
  return { status: 0, data: {} };
}

export function useSignupFlow() {
  const initSignup = async (input: {
    phone: string;
    email: string;
    password: string;
  }): Promise<InitResult> => {
    // The country picker hands back '+66' + whatever was typed, so a Thai user
    // entering the local '0614929599' would put a trunk 0 on the wire
    // ('+660614929599'). Normalising here — the one place a phone number leaves
    // the client — keeps the stored number canonical instead of relying on the
    // Edge Function's parser to absorb it. resend-code takes only a session id,
    // so it has no phone value to normalise.
    const { status, data } = await invokeFunction('init-signup', {
      ...input,
      phone: normalizePhoneE164(input.phone),
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      sessionId: data.session_id as string | undefined,
      phoneMasked: data.phone_masked as string | undefined,
      emailMasked: data.email_masked as string | undefined,
      smsSent: data.sms_sent as boolean | undefined,
      emailSent: data.email_sent as boolean | undefined,
      error: data.error as string | undefined,
      reason: data.reason as string | undefined,
      retryAfterSeconds: data.retry_after_seconds as number | undefined,
    };
  };

  const completeSignup = async (input: {
    sessionId: string;
    smsCode: string;
    emailCode: string;
  }): Promise<CompleteResult> => {
    const res = await fetch(apiUrl('/api/auth/complete-signup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: input.sessionId,
        sms_code: input.smsCode,
        email_code: input.emailCode,
      }),
    });
    const data = await readJson(res);
    return {
      ok: res.ok && typeof data.access_token === 'string',
      status: res.status,
      accessToken: data.access_token as string | undefined,
      refreshToken: data.refresh_token as string | undefined,
      smsInvalid: data.sms_invalid as boolean | undefined,
      emailInvalid: data.email_invalid as boolean | undefined,
      error: data.error as string | undefined,
    };
  };

  const resend = async (
    sessionId: string,
    channel: 'sms' | 'email',
  ): Promise<ResendResult> => {
    const { status, data } = await invokeFunction('resend-code', {
      session_id: sessionId,
      channel,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      error: data.error as string | undefined,
      retryAfterSeconds: data.retry_after_seconds as number | undefined,
    };
  };

  return { initSignup, completeSignup, resend };
}
