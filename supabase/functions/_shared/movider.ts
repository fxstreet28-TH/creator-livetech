/**
 * SMS OTP delivery via Movider. Deno port of lib/movider.ts.
 *
 * Movider's REST API is form-encoded (application/x-www-form-urlencoded) and
 * authenticates with `api_key` + `api_secret` fields in the body — NOT a Bearer
 * token. The `to` field must be E.164 WITHOUT the leading '+'.
 * See https://developer.movider.co/reference/post_sms
 *
 * The only changes from the Node original are process.env -> Deno.env.get.
 * fetch, URLSearchParams and console are identical in both runtimes.
 */

const MOVIDER_API_URL = 'https://api.movider.co/v1/sms';

export interface SendSmsInput {
  to: string; // E.164 format WITH leading '+', e.g. '+66994247994' — we strip it before sending
  text: string;
  from?: string;
}

export interface SendSmsResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  remainingBalance?: number;
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const apiKey = Deno.env.get('MOVIDER_API_KEY');
  const apiSecret = Deno.env.get('MOVIDER_API_SECRET');
  const senderName = input.from ?? Deno.env.get('MOVIDER_SENDER_NAME');

  if (!apiKey || !apiSecret) {
    console.error('[movider] MOVIDER_API_KEY or MOVIDER_API_SECRET not set');
    return { ok: false, error: 'sms_provider_misconfigured' };
  }

  // Movider expects E.164 without the leading '+'
  const toStripped = input.to.replace(/^\+/, '');

  const body = new URLSearchParams();
  body.set('api_key', apiKey);
  body.set('api_secret', apiSecret);
  body.set('to', toStripped);
  body.set('text', input.text);
  // Only send an alphanumeric sender name when one is configured. While the
  // "AURUM" sender ID is unapproved for TH, omitting `from` lets Movider fall
  // back to a generic numeric sender so SMS still deliver.
  if (senderName && senderName.trim().length > 0) {
    body.set('from', senderName);
  }

  try {
    const res = await fetch(MOVIDER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const rawText = await res.text();
    let data: {
      remaining_balance?: number;
      phone_number_list?: Array<{ number?: string; message_id?: string }>;
      bad_phone_number_list?: Array<{ number?: string; reason?: string }>;
      error?: { description?: string } | string;
    };
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error('[movider] non-JSON response', { status: res.status, rawText });
      return { ok: false, error: 'sms_provider_invalid_response' };
    }

    // Check for bad phones (invalid, unreachable, etc.)
    if (Array.isArray(data.bad_phone_number_list) && data.bad_phone_number_list.length > 0) {
      const bad = data.bad_phone_number_list[0];
      console.error('[movider] bad phone', { status: res.status, bad, fullResponse: data });
      return { ok: false, error: bad?.reason ?? 'sms_bad_phone' };
    }

    // Check for successful sends
    if (res.ok && Array.isArray(data.phone_number_list) && data.phone_number_list.length > 0) {
      const messageId = data.phone_number_list[0]?.message_id;
      console.log('[movider] send successful', {
        messageId,
        remainingBalance: data.remaining_balance,
      });
      return {
        ok: true,
        messageId,
        remainingBalance: data.remaining_balance,
      };
    }

    // Top-level error
    console.error('[movider] send failed', { status: res.status, data });
    const topError =
      (typeof data.error === 'object' ? data.error?.description : data.error) ?? 'sms_send_failed';
    return { ok: false, error: topError };
  } catch (err) {
    console.error('[movider] exception', err);
    return { ok: false, error: 'sms_provider_exception' };
  }
}
