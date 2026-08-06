import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-server';
import { formatPhoneE164 } from '@/lib/phone';
import { isValidEmail } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { phone?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // Rate limit: 30/min/IP
  const ip = getClientIp(req);
  const rl = await checkRateLimit({
    key: `ip:${ip}`,
    action: 'check',
    windowSeconds: 60,
    maxRequests: 30,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retry_after_seconds: rl.retryAfterSeconds },
      { status: 429 },
    );
  }

  const supabase = getServiceSupabase();
  const result: { phone_available?: boolean; email_available?: boolean } = {};

  if (typeof body.phone === 'string') {
    const e164 = formatPhoneE164(body.phone);
    if (!e164) {
      result.phone_available = false;
    } else {
      const { data, error } = await supabase
        .from('customers')
        .select('id')
        .eq('phone', e164)
        .not('phone_verified_at', 'is', null)
        .limit(1);
      result.phone_available = error ? true : (data?.length ?? 0) === 0;
    }
  }

  if (typeof body.email === 'string') {
    const email = body.email.trim().toLowerCase();
    if (!isValidEmail(email)) {
      result.email_available = false;
    } else {
      const { data, error } = await supabase
        .from('customers')
        .select('id')
        .eq('email', email)
        .not('email_verified_at', 'is', null)
        .limit(1);
      result.email_available = error ? true : (data?.length ?? 0) === 0;
    }
  }

  return NextResponse.json(result, { status: 200 });
}
