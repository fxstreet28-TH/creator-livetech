/**
 * init-signup — Deno port of app/api/auth/init-signup/route.ts.
 *
 * Creates a signup_sessions row, generates the SMS + email codes, and sends
 * both. The request and response shapes, the error codes and the HTTP statuses
 * are byte-equivalent to the Next.js route it replaces, because
 * components/auth/steps/Step1Credentials.tsx maps those codes to Thai copy and
 * components/auth/hooks/useSignupFlow.ts reads the snake_case body fields.
 *
 * That contract is also why the bodies below are built with successResponse()
 * rather than _shared/errors.ts errorResponse(): errorResponse emits its own
 * code set ('invalid_input', 'not_found', ...) plus a message/detail envelope,
 * which the existing client does not understand. _shared stays untouched.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { successResponse } from '../_shared/errors.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { generateOtp, hashOtp, encryptPassword } from '../_shared/otp.ts';
import { sendSms } from '../_shared/movider.ts';
import { sendEmailVerificationCode } from '../_shared/resend.ts';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

// --- Ports of the client-safe lib/* helpers the Node route imports. They are
// inlined per function rather than added to _shared/ so PR 5a's utilities stay
// exactly as they were finalised. -------------------------------------------

/** Port of lib/phone.ts formatPhoneE164. */
function formatPhoneE164(input: string, defaultCountry: CountryCode = 'TH'): string | null {
  if (!input) return null;
  try {
    const parsed = parsePhoneNumberFromString(input, defaultCountry);
    if (!parsed || !parsed.isValid()) return null;
    return parsed.format('E.164');
  } catch {
    return null;
  }
}

// Port of lib/validation.ts.
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  return EMAIL_RE.test(email);
}

type PasswordCheck = { ok: boolean; reason?: 'too_short' | 'need_letter' | 'need_number' };

function validatePassword(pw: string): PasswordCheck {
  if (!pw || pw.length < 8) return { ok: false, reason: 'too_short' };
  if (!/[A-Za-z]/.test(pw)) return { ok: false, reason: 'need_letter' };
  if (!/[0-9]/.test(pw)) return { ok: false, reason: 'need_number' };
  return { ok: true };
}

// Port of lib/mask.ts.
function maskPhone(e164: string): string {
  const rest = e164.startsWith('+66') ? e164.slice(3) : e164.replace(/^\+/, '');
  if (rest.length < 5) return e164;
  return `+66 ${rest[0]}X-XXX-${rest.slice(-4)}`;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local[0] ?? '';
  return `${visible}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}

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

  let body: { phone?: unknown; email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return successResponse({ error: 'invalid_body' }, origin, 400);
  }

  // 1. Phone
  // Frontend already sends E.164; this is a server-side sanity check.
  const e164 = typeof body.phone === 'string' ? formatPhoneE164(body.phone) : null;
  if (!e164) {
    return successResponse({ error: 'invalid_phone' }, origin, 400);
  }

  // 2. Email + password
  if (typeof body.email !== 'string' || !isValidEmail(body.email)) {
    return successResponse({ error: 'invalid_email' }, origin, 400);
  }
  const email = body.email.trim().toLowerCase();

  const pw = validatePassword(typeof body.password === 'string' ? body.password : '');
  if (!pw.ok) {
    return successResponse({ error: 'invalid_password', reason: pw.reason }, origin, 400);
  }
  const password = body.password as string;

  const supabase = serviceClient();

  // 3. Already-registered check (verified accounts only)
  try {
    const [{ data: byPhone }, { data: byEmail }] = await Promise.all([
      supabase
        .from('customers')
        .select('id')
        .eq('phone', e164)
        .not('phone_verified_at', 'is', null)
        .limit(1),
      supabase
        .from('customers')
        .select('id')
        .eq('email', email)
        .not('email_verified_at', 'is', null)
        .limit(1),
    ]);
    if ((byPhone && byPhone.length > 0) || (byEmail && byEmail.length > 0)) {
      return successResponse({ error: 'already_registered' }, origin, 409);
    }
  } catch (err) {
    // Fail open on the pre-check (unique constraints still protect us later),
    // but log — this usually means the migration has not been applied yet.
    console.error('[init-signup] availability check failed', err);
  }

  // 4. Rate limits
  const ip = getClientIp(req);
  const limits = await Promise.all([
    checkRateLimit({ key: `phone:${e164}`, action: 'send_sms', windowSeconds: 3600, maxRequests: 3 }),
    checkRateLimit({ key: `ip:${ip}`, action: 'send_sms', windowSeconds: 3600, maxRequests: 5 }),
    checkRateLimit({ key: `email:${email}`, action: 'send_email', windowSeconds: 3600, maxRequests: 5 }),
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

  // 5-6. Encrypt password + create session
  const passwordEncrypted = await encryptPassword(password);
  const { data: session, error: sessionErr } = await supabase
    .from('signup_sessions')
    .insert({
      phone: e164,
      email,
      password_encrypted: passwordEncrypted,
      ip_address: ip === 'unknown' ? null : ip,
      user_agent: req.headers.get('user-agent') ?? null,
    })
    .select('id')
    .single();

  if (sessionErr || !session) {
    console.error('[init-signup] session insert failed', sessionErr);
    return successResponse({ error: 'server_error' }, origin, 500);
  }

  // 7-8. Generate + store codes
  const smsCode = generateOtp(6);
  const emailCode = generateOtp(6);
  const [smsHash, emailHash] = await Promise.all([hashOtp(smsCode), hashOtp(emailCode)]);
  const [{ error: otpErr }, { error: codeErr }] = await Promise.all([
    supabase.from('phone_otps').insert({
      session_id: session.id,
      phone: e164,
      code_hash: smsHash,
    }),
    supabase.from('email_codes').insert({
      session_id: session.id,
      email,
      code_hash: emailHash,
    }),
  ]);

  if (otpErr || codeErr) {
    console.error('[init-signup] code insert failed', { otpErr, codeErr });
    await supabase.from('signup_sessions').delete().eq('id', session.id);
    return successResponse({ error: 'server_error' }, origin, 500);
  }

  // 9. Send both in parallel
  const smsText = `รหัสยืนยัน AURUM Live ของคุณคือ ${smsCode} (หมดอายุใน 5 นาที) อย่าเปิดเผยรหัสนี้ให้ผู้อื่น`;
  const [smsRes, emailRes] = await Promise.all([
    sendSms({ to: e164, text: smsText }),
    sendEmailVerificationCode({ to: email, code: emailCode }),
  ]);

  // 10. Both failed → tear down
  if (!smsRes.ok && !emailRes.ok) {
    await supabase.from('signup_sessions').delete().eq('id', session.id);
    return successResponse({ error: 'provider_failure' }, origin, 502);
  }

  // 11-12. One or both succeeded → keep session, flag partial failure
  return successResponse(
    {
      session_id: session.id,
      phone_masked: maskPhone(e164),
      email_masked: maskEmail(email),
      sms_sent: smsRes.ok,
      email_sent: emailRes.ok,
    },
    origin,
  );
});
