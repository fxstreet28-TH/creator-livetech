/**
 * resend-code — Deno port of app/api/auth/resend-code/route.ts.
 *
 * Re-issues one channel's verification code for an existing signup session:
 * same rate-limit policy as init-signup, plus a 60s per-channel cooldown, plus
 * invalidation of the previous unverified codes.
 *
 * As in init-signup, responses are built with successResponse() so the error
 * codes and statuses stay byte-equivalent to the Next.js route — Step2Verify
 * branches on `status === 429` and `retry_after_seconds`. _shared stays
 * untouched.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { successResponse } from '../_shared/errors.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { generateOtp, hashOtp } from '../_shared/otp.ts';
import { sendSms } from '../_shared/movider.ts';
import { sendEmailVerificationCode } from '../_shared/resend.ts';

const RESEND_COOLDOWN_SECONDS = 60;

/** Port of lib/http.ts getClientIp — Supabase's edge proxy sets x-forwarded-for. */
function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  if (req.method !== 'POST') {
    return successResponse({ error: 'method_not_allowed' }, origin, 405);
  }

  let body: { session_id?: unknown; channel?: unknown };
  try {
    body = await req.json();
  } catch {
    return successResponse({ error: 'invalid_body' }, origin, 400);
  }

  const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
  const channel = body.channel === 'sms' || body.channel === 'email' ? body.channel : null;
  if (!sessionId || !channel) {
    return successResponse({ error: 'invalid_body' }, origin, 400);
  }

  const supabase = serviceClient();

  // 1. Load session
  const { data: session } = await supabase
    .from('signup_sessions')
    .select('id, phone, email, expires_at')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session || new Date(session.expires_at) < new Date()) {
    return successResponse({ error: 'session_not_found' }, origin, 404);
  }

  // 2. Rate limit (same policy as init)
  const ip = getClientIp(req);
  const limits =
    channel === 'sms'
      ? await Promise.all([
          checkRateLimit({ key: `phone:${session.phone}`, action: 'send_sms', windowSeconds: 3600, maxRequests: 3 }),
          checkRateLimit({ key: `ip:${ip}`, action: 'send_sms', windowSeconds: 3600, maxRequests: 5 }),
        ])
      : await Promise.all([
          checkRateLimit({ key: `email:${session.email}`, action: 'send_email', windowSeconds: 3600, maxRequests: 5 }),
          checkRateLimit({ key: `ip:${ip}`, action: 'send_email', windowSeconds: 3600, maxRequests: 10 }),
        ]);
  const tripped = limits.find((l) => !l.ok);
  if (tripped) {
    return successResponse(
      { error: 'rate_limited', retry_after_seconds: tripped.retryAfterSeconds },
      origin,
      429,
    );
  }

  const table = channel === 'sms' ? 'phone_otps' : 'email_codes';

  // 3. 60s cooldown since last code of same channel
  const { data: last } = await supabase
    .from(table)
    .select('created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (last) {
    const elapsed = (Date.now() - new Date(last.created_at).getTime()) / 1000;
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      return successResponse(
        { error: 'cooldown', retry_after_seconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed) },
        origin,
        429,
      );
    }
  }

  // 4. Invalidate previous unverified codes for this session + channel
  const nowIso = new Date().toISOString();
  await supabase
    .from(table)
    .update({ expires_at: nowIso })
    .eq('session_id', sessionId)
    .is('verified_at', null)
    .gt('expires_at', nowIso);

  // 5. Generate + send new
  const code = generateOtp(6);
  const codeHash = await hashOtp(code);
  if (channel === 'sms') {
    const { error } = await supabase
      .from('phone_otps')
      .insert({ session_id: sessionId, phone: session.phone, code_hash: codeHash });
    if (error) {
      console.error('[resend-code] insert failed', error);
      return successResponse({ error: 'server_error' }, origin, 500);
    }
    const text = `รหัสยืนยัน AURUM Live ของคุณคือ ${code} (หมดอายุใน 5 นาที) อย่าเปิดเผยรหัสนี้ให้ผู้อื่น`;
    const res = await sendSms({ to: session.phone, text });
    if (!res.ok) return successResponse({ error: 'sms_send_failed' }, origin, 502);
  } else {
    const { error } = await supabase
      .from('email_codes')
      .insert({ session_id: sessionId, email: session.email, code_hash: codeHash });
    if (error) {
      console.error('[resend-code] insert failed', error);
      return successResponse({ error: 'server_error' }, origin, 500);
    }
    const res = await sendEmailVerificationCode({ to: session.email, code });
    if (!res.ok) return successResponse({ error: 'email_send_failed' }, origin, 502);
  }

  return successResponse({ ok: true }, origin);
});
