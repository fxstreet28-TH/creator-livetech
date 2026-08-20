'use client';

/**
 * Thin client-side wrapper around the /api/auth/* routes. Each method returns a
 * discriminated result so step components can drive their own loading/error UI.
 */

import { apiUrl } from '@/lib/config';

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

export function useSignupFlow() {
  const initSignup = async (input: {
    phone: string;
    email: string;
    password: string;
  }): Promise<InitResult> => {
    const res = await fetch(apiUrl('/api/auth/init-signup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await readJson(res);
    return {
      ok: res.ok,
      status: res.status,
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
    const res = await fetch(apiUrl('/api/auth/resend-code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, channel }),
    });
    const data = await readJson(res);
    return {
      ok: res.ok,
      status: res.status,
      error: data.error as string | undefined,
      retryAfterSeconds: data.retry_after_seconds as number | undefined,
    };
  };

  return { initSignup, completeSignup, resend };
}
