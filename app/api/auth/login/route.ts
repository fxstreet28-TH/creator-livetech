import { NextRequest, NextResponse } from 'next/server';
import { getRouteHandlerSupabase } from '@/lib/supabase-server';
import { isValidEmail } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Server-side login. Signs the user in with Supabase and lets `@supabase/ssr`
 * write the session cookies onto the response so the middleware auth guard
 * (middleware.ts) sees the user on the next request.
 *
 * Error messages are intentionally generic: a wrong password and a
 * non-existent email return the SAME 401 so we never reveal which field was
 * wrong. The password is never logged.
 */
export async function POST(req: NextRequest) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // Reject empty fields / malformed email up front with a generic message.
  if (!email || !password || !isValidEmail(email)) {
    return NextResponse.json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' }, { status: 400 });
  }

  const supabase = await getRouteHandlerSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    console.error('[login] failed', { supabaseError: error, email });

    const status = error.status;
    const code = (error as { code?: string }).code;
    const message = error.message?.toLowerCase() ?? '';

    // Supabase's built-in rate limiting.
    if (status === 429 || code?.includes('rate') || message.includes('rate limit')) {
      return NextResponse.json({ error: 'ทดลองมากเกินไป กรุณารอสักครู่' }, { status: 429 });
    }

    // Unverified email (also arrives as HTTP 400, so check it before the
    // generic invalid-credentials branch below).
    if (code === 'email_not_confirmed' || message.includes('not confirmed')) {
      return NextResponse.json({ error: 'กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ' }, { status: 403 });
    }

    // Wrong password OR non-existent email — same message, same status.
    if (status === 400 || code === 'invalid_credentials' || message.includes('invalid login')) {
      return NextResponse.json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' }, { status: 401 });
    }

    return NextResponse.json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' }, { status: 500 });
  }

  return NextResponse.json(
    {
      success: true,
      session: {
        access_token: data.session!.access_token,
        refresh_token: data.session!.refresh_token,
      },
    },
    { status: 200 },
  );
}
