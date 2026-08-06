import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-server';
import { formatThaiPhoneE164, sendSms } from '@/lib/movider';
import { sendEmailVerificationCode } from '@/lib/email';
import { generateOtp, hashOtp, encryptPassword } from '@/lib/otp';
import { checkRateLimit } from '@/lib/rateLimit';
import { isValidEmail, validatePassword } from '@/lib/validation';
import { maskPhone, maskEmail } from '@/lib/mask';
import { getClientIp } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { phone?: unknown; email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // 1. Phone
  const e164 =
    typeof body.phone === 'string' ? formatThaiPhoneE164(body.phone) : null;
  if (!e164) {
    return NextResponse.json({ error: 'invalid_phone' }, { status: 400 });
  }

  // 2. Email + password
  if (typeof body.email !== 'string' || !isValidEmail(body.email)) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();

  const pw = validatePassword(typeof body.password === 'string' ? body.password : '');
  if (!pw.ok) {
    return NextResponse.json(
      { error: 'invalid_password', reason: pw.reason },
      { status: 400 },
    );
  }
  const password = body.password as string;

  const supabase = getServiceSupabase();

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
      return NextResponse.json({ error: 'already_registered' }, { status: 409 });
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
    return NextResponse.json(
      { error: 'rate_limited', retry_after_seconds: tripped.retryAfterSeconds },
      { status: 429 },
    );
  }

  // 5-6. Encrypt password + create session
  const passwordEncrypted = encryptPassword(password);
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
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  // 7-8. Generate + store codes
  const smsCode = generateOtp(6);
  const emailCode = generateOtp(6);
  const [{ error: otpErr }, { error: codeErr }] = await Promise.all([
    supabase.from('phone_otps').insert({
      session_id: session.id,
      phone: e164,
      code_hash: hashOtp(smsCode),
    }),
    supabase.from('email_codes').insert({
      session_id: session.id,
      email,
      code_hash: hashOtp(emailCode),
    }),
  ]);

  if (otpErr || codeErr) {
    console.error('[init-signup] code insert failed', { otpErr, codeErr });
    await supabase.from('signup_sessions').delete().eq('id', session.id);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
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
    return NextResponse.json({ error: 'provider_failure' }, { status: 502 });
  }

  // 11-12. One or both succeeded → keep session, flag partial failure
  return NextResponse.json(
    {
      session_id: session.id,
      phone_masked: maskPhone(e164),
      email_masked: maskEmail(email),
      sms_sent: smsRes.ok,
      email_sent: emailRes.ok,
    },
    { status: 200 },
  );
}
