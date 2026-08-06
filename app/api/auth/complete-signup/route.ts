import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, getAnonSupabase } from '@/lib/supabase-server';
import { verifyOtp, decryptPassword } from '@/lib/otp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ATTEMPTS = 5;

export async function POST(req: NextRequest) {
  let body: { session_id?: unknown; sms_code?: unknown; email_code?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
  const smsCode = typeof body.sms_code === 'string' ? body.sms_code : '';
  const emailCode = typeof body.email_code === 'string' ? body.email_code : '';
  if (!sessionId) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const supabase = getServiceSupabase();

  // 1. Load session
  const { data: session } = await supabase
    .from('signup_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }
  if (new Date(session.expires_at) < new Date()) {
    return NextResponse.json({ error: 'expired' }, { status: 410 });
  }

  // 2. Latest unverified code for each channel
  const [{ data: phoneOtp }, { data: emailCodeRow }] = await Promise.all([
    supabase
      .from('phone_otps')
      .select('*')
      .eq('session_id', sessionId)
      .is('verified_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('email_codes')
      .select('*')
      .eq('session_id', sessionId)
      .is('verified_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!phoneOtp || !emailCodeRow) {
    return NextResponse.json({ error: 'expired' }, { status: 400 });
  }

  // 3. Increment attempts, enforce cap
  const phoneAttempts = (phoneOtp.attempts ?? 0) + 1;
  const emailAttempts = (emailCodeRow.attempts ?? 0) + 1;
  await Promise.all([
    supabase.from('phone_otps').update({ attempts: phoneAttempts }).eq('id', phoneOtp.id),
    supabase.from('email_codes').update({ attempts: emailAttempts }).eq('id', emailCodeRow.id),
  ]);

  if (phoneAttempts > MAX_ATTEMPTS || emailAttempts > MAX_ATTEMPTS) {
    const nowIso = new Date().toISOString();
    await Promise.all([
      supabase.from('phone_otps').update({ expires_at: nowIso }).eq('id', phoneOtp.id),
      supabase.from('email_codes').update({ expires_at: nowIso }).eq('id', emailCodeRow.id),
    ]);
    return NextResponse.json({ error: 'too_many_attempts' }, { status: 400 });
  }

  // Expiry of the individual codes
  const now = new Date();
  if (new Date(phoneOtp.expires_at) < now || new Date(emailCodeRow.expires_at) < now) {
    return NextResponse.json({ error: 'expired' }, { status: 400 });
  }

  // 4. Verify both
  const smsOk = smsCode.length === 6 && verifyOtp(smsCode, phoneOtp.code_hash);
  const emailOk = emailCode.length === 6 && verifyOtp(emailCode, emailCodeRow.code_hash);

  // 5. Either fails
  if (!smsOk || !emailOk) {
    return NextResponse.json(
      { error: 'code_invalid', sms_invalid: !smsOk, email_invalid: !emailOk },
      { status: 400 },
    );
  }

  // 6. Both pass — provision the account
  const nowIso = new Date().toISOString();
  await Promise.all([
    supabase.from('phone_otps').update({ verified_at: nowIso }).eq('id', phoneOtp.id),
    supabase.from('email_codes').update({ verified_at: nowIso }).eq('id', emailCodeRow.id),
    supabase
      .from('signup_sessions')
      .update({ phone_verified_at: nowIso, email_verified_at: nowIso })
      .eq('id', sessionId),
  ]);

  let password: string;
  try {
    password = decryptPassword(session.password_encrypted);
  } catch (err) {
    console.error('[complete-signup] password decrypt failed', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  // (d) Create the auth user
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: session.email,
    phone: session.phone,
    password,
    email_confirm: true,
    phone_confirm: true,
  });

  if (createErr || !created?.user) {
    console.error('[complete-signup] createUser failed', createErr?.message);
    const alreadyExists = createErr?.message?.toLowerCase().includes('already');
    return NextResponse.json(
      { error: alreadyExists ? 'already_registered' : 'account_creation_failed' },
      { status: alreadyExists ? 409 : 500 },
    );
  }
  const userId = created.user.id;

  // (e) Seed customers row
  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .insert({
      user_id: userId,
      phone: session.phone,
      email: session.email,
      phone_verified_at: nowIso,
      email_verified_at: nowIso,
      role: 'creator',
    })
    .select('id')
    .single();

  if (custErr) {
    console.error('[complete-signup] customers insert failed', custErr);
  }

  // (f) Seed creators row (kyc pending). Non-fatal if the schema differs.
  const { error: creatorErr } = await supabase.from('creators').insert({
    user_id: userId,
    customer_id: customer?.id ?? null,
    kyc_status: 'pending',
  });
  if (creatorErr) {
    console.error('[complete-signup] creators insert (non-fatal)', creatorErr);
  }

  // (g) Sign in to mint session tokens
  const anon = getAnonSupabase();
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email: session.email,
    password,
  });

  if (signInErr || !signIn.session) {
    console.error('[complete-signup] sign-in failed', signInErr?.message);
    // Account was created; the user can still log in manually.
    return NextResponse.json(
      { error: 'signin_after_signup_failed', user: { id: userId, email: session.email } },
      { status: 200 },
    );
  }

  // (i) Housekeeping — remove the session (OTP rows cascade)
  await supabase.from('signup_sessions').delete().eq('id', sessionId);

  // (h) Return tokens
  return NextResponse.json(
    {
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      user: signIn.user,
    },
    { status: 200 },
  );
}
