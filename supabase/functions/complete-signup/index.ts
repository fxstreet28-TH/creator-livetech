/**
 * complete-signup — Deno port of app/api/auth/complete-signup/route.ts.
 *
 * Verifies both OTPs, provisions the account (auth.users + customers +
 * creators), mints session tokens and tears the signup session down. This is
 * the only function in the signup flow that writes to auth.users, which is why
 * it runs on the service-role client.
 *
 * As in init-signup and resend-code, the request and response shapes, the error
 * codes and the HTTP statuses are byte-equivalent to the Next.js route it
 * replaces. That matters more here than anywhere else in the migration:
 * components/auth/steps/Step2Verify.tsx branches on `error === 'code_invalid'`
 * with the per-channel `sms_invalid` / `email_invalid` flags, on
 * `error === 'too_many_attempts'`, and on `status === 410`. The success body
 * stays FLAT — `access_token` / `refresh_token` / `user` at the top level, not
 * nested under a `session` key — so reverting the frontend commit swings
 * traffic back to the still-live Vercel route without a wire-format change.
 *
 * Responses are built with successResponse() rather than _shared/errors.ts
 * errorResponse() for the same reason as the other two functions: errorResponse
 * emits its own code set plus a message/detail envelope that this client does
 * not understand.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { successResponse } from '../_shared/errors.ts';
import { serviceClient, anonClient } from '../_shared/supabase.ts';
import { verifyOtp, decryptPassword } from '../_shared/otp.ts';

const MAX_ATTEMPTS = 5;

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  if (req.method !== 'POST') {
    return successResponse({ error: 'method_not_allowed' }, origin, 405);
  }

  let body: { session_id?: unknown; sms_code?: unknown; email_code?: unknown };
  try {
    body = await req.json();
  } catch {
    return successResponse({ error: 'invalid_body' }, origin, 400);
  }

  const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
  const smsCode = typeof body.sms_code === 'string' ? body.sms_code : '';
  const emailCode = typeof body.email_code === 'string' ? body.email_code : '';
  if (!sessionId) {
    return successResponse({ error: 'invalid_body' }, origin, 400);
  }

  const supabase = serviceClient();

  // 1. Load session
  const { data: session } = await supabase
    .from('signup_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session) {
    return successResponse({ error: 'session_not_found' }, origin, 404);
  }
  if (new Date(session.expires_at) < new Date()) {
    return successResponse({ error: 'expired' }, origin, 410);
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
    return successResponse({ error: 'expired' }, origin, 400);
  }

  // 3. Increment attempts, enforce cap
  const phoneAttempts = (phoneOtp.attempts ?? 0) + 1;
  const emailAttempts = (emailCodeRow.attempts ?? 0) + 1;
  await Promise.all([
    supabase.from('phone_otps').update({ attempts: phoneAttempts }).eq('id', phoneOtp.id),
    supabase.from('email_codes').update({ attempts: emailAttempts }).eq('id', emailCodeRow.id),
  ]);

  if (phoneAttempts > MAX_ATTEMPTS || emailAttempts > MAX_ATTEMPTS) {
    const expiredIso = new Date().toISOString();
    await Promise.all([
      supabase.from('phone_otps').update({ expires_at: expiredIso }).eq('id', phoneOtp.id),
      supabase.from('email_codes').update({ expires_at: expiredIso }).eq('id', emailCodeRow.id),
    ]);
    return successResponse({ error: 'too_many_attempts' }, origin, 400);
  }

  // Expiry of the individual codes
  const now = new Date();
  if (new Date(phoneOtp.expires_at) < now || new Date(emailCodeRow.expires_at) < now) {
    return successResponse({ error: 'expired' }, origin, 400);
  }

  // 4. Verify both. verifyOtp is async here (Web Crypto) where lib/otp.ts is
  // synchronous (node:crypto) — the digests are identical, only the call is.
  const [smsOk, emailOk] = await Promise.all([
    smsCode.length === 6 ? verifyOtp(smsCode, phoneOtp.code_hash) : Promise.resolve(false),
    emailCode.length === 6 ? verifyOtp(emailCode, emailCodeRow.code_hash) : Promise.resolve(false),
  ]);

  // 5. Either fails
  if (!smsOk || !emailOk) {
    return successResponse(
      { error: 'code_invalid', sms_invalid: !smsOk, email_invalid: !emailOk },
      origin,
      400,
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
    password = await decryptPassword(session.password_encrypted);
  } catch (err) {
    console.error('[complete-signup] password decrypt failed', err);
    return successResponse({ error: 'server_error' }, origin, 500);
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
    return successResponse(
      { error: alreadyExists ? 'already_registered' : 'account_creation_failed' },
      origin,
      alreadyExists ? 409 : 500,
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
  const anon = anonClient();
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email: session.email,
    password,
  });

  if (signInErr || !signIn.session) {
    console.error('[complete-signup] sign-in failed', signInErr?.message);
    // Account was created; the user can still log in manually.
    return successResponse(
      { error: 'signin_after_signup_failed', user: { id: userId, email: session.email } },
      origin,
      200,
    );
  }

  // (i) Housekeeping — remove the session (OTP rows cascade)
  await supabase.from('signup_sessions').delete().eq('id', sessionId);

  // (h) Return tokens
  return successResponse(
    {
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      user: signIn.user,
    },
    origin,
  );
});
