import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-server';
import { sendSms } from '@/lib/movider';
import { sendEmailVerificationCode } from '@/lib/email';
import { generateOtp, hashOtp } from '@/lib/otp';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESEND_COOLDOWN_SECONDS = 60;

export async function POST(req: NextRequest) {
  let body: { session_id?: unknown; channel?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
  const channel = body.channel === 'sms' || body.channel === 'email' ? body.channel : null;
  if (!sessionId || !channel) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const supabase = getServiceSupabase();

  // 1. Load session
  const { data: session } = await supabase
    .from('signup_sessions')
    .select('id, phone, email, expires_at')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session || new Date(session.expires_at) < new Date()) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
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
    return NextResponse.json(
      { error: 'rate_limited', retry_after_seconds: tripped.retryAfterSeconds },
      { status: 429 },
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
      return NextResponse.json(
        { error: 'cooldown', retry_after_seconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed) },
        { status: 429 },
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
  if (channel === 'sms') {
    const { error } = await supabase
      .from('phone_otps')
      .insert({ session_id: sessionId, phone: session.phone, code_hash: hashOtp(code) });
    if (error) {
      console.error('[resend-code] insert failed', error);
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
    const text = `รหัสยืนยัน AURUM Live ของคุณคือ ${code} (หมดอายุใน 5 นาที) อย่าเปิดเผยรหัสนี้ให้ผู้อื่น`;
    const res = await sendSms({ to: session.phone, text });
    if (!res.ok) return NextResponse.json({ error: 'sms_send_failed' }, { status: 502 });
  } else {
    const { error } = await supabase
      .from('email_codes')
      .insert({ session_id: sessionId, email: session.email, code_hash: hashOtp(code) });
    if (error) {
      console.error('[resend-code] insert failed', error);
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
    const res = await sendEmailVerificationCode({ to: session.email, code });
    if (!res.ok) return NextResponse.json({ error: 'email_send_failed' }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
