import 'server-only';

// Re-export the client-safe phone helper so existing server imports from
// '@/lib/movider' keep working while client components import from '@/lib/phone'.
export { formatThaiPhoneE164 } from './phone';

const MOVIDER_API_URL = 'https://api.movider.co/v1/sms';

interface SendSmsInput {
  to: string; // E.164 format, e.g. +66812345678
  text: string;
  from?: string;
}

interface SendSmsResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const apiKey = process.env.MOVIDER_API_KEY;
  const senderName = input.from ?? process.env.MOVIDER_SENDER_NAME ?? 'AURUM';

  if (!apiKey) {
    console.error('[movider] MOVIDER_API_KEY not set');
    return { ok: false, error: 'sms_provider_misconfigured' };
  }

  try {
    const res = await fetch(MOVIDER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to: input.to,
        text: input.text,
        from: senderName,
      }),
    });

    let data: Record<string, unknown> = {};
    try {
      data = await res.json();
    } catch {
      // some gateways return empty bodies on success
    }

    // Movider signals success either via HTTP 2xx or a `status: "success"` field
    // depending on the endpoint variant. Treat a non-2xx OR an explicit failure
    // status as an error.
    const explicitFailure = data.status !== undefined && data.status !== 'success';
    if (!res.ok || explicitFailure) {
      console.error('[movider] send failed', { status: res.status });
      const message = typeof data.message === 'string' ? data.message : 'sms_send_failed';
      return { ok: false, error: message };
    }

    const messageId =
      (typeof data.message_id === 'string' && data.message_id) ||
      (typeof data.messageId === 'string' && data.messageId) ||
      undefined;

    return { ok: true, messageId };
  } catch (err) {
    console.error('[movider] exception', err);
    return { ok: false, error: 'sms_provider_exception' };
  }
}
