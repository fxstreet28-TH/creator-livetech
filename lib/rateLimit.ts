import 'server-only';
import { getServiceSupabase } from './supabase-server';

interface RateLimitInput {
  key: string; // "phone:+66812345678", "email:foo@bar.com", "ip:1.2.3.4"
  action: string; // "send_sms", "send_email", "verify", "check"
  windowSeconds: number;
  maxRequests: number;
}

interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds?: number;
}

/**
 * Sliding-window rate limiter backed by the `auth_rate_limits` ledger table.
 * Counts rows for (key, action) within the window; if under the limit it
 * records a new row and allows the request. Fails OPEN (allows) on query
 * error so a transient DB issue never fully blocks signup — but logs loudly.
 */
export async function checkRateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  const supabase = getServiceSupabase();
  const windowStart = new Date(Date.now() - input.windowSeconds * 1000).toISOString();

  const { count, error } = await supabase
    .from('auth_rate_limits')
    .select('*', { count: 'exact', head: true })
    .eq('key', input.key)
    .eq('action', input.action)
    .gte('created_at', windowStart);

  if (error) {
    console.error('[rateLimit] query failed', error);
    return { ok: true }; // fail open, log loudly
  }

  if ((count ?? 0) >= input.maxRequests) {
    return { ok: false, retryAfterSeconds: input.windowSeconds };
  }

  const { error: insertError } = await supabase
    .from('auth_rate_limits')
    .insert({ key: input.key, action: input.action });

  if (insertError) {
    console.error('[rateLimit] insert failed', insertError);
  }

  return { ok: true };
}
