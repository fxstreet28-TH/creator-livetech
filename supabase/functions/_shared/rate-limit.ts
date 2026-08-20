import { serviceClient } from './supabase.ts';

export interface RateLimitInput {
  key: string; // "phone:+66812345678", "email:foo@bar.com", "ip:1.2.3.4"
  action: string; // "send_sms", "send_email", "verify", "check"
  windowSeconds: number;
  maxRequests: number;
}

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds?: number;
}

/**
 * Sliding-window rate limiter backed by the `auth_rate_limits` ledger table.
 * Deno port of lib/rateLimit.ts — same signature, same semantics, so the
 * Edge Functions in PRs 5b/5c enforce exactly the limits the Next.js routes
 * enforce today.
 *
 * The table is a LEDGER, not a counter (supabase/migrations/20260806_signup_auth_tables.sql:96):
 *   id uuid primary key default gen_random_uuid(),
 *   key text not null,
 *   action text not null,
 *   created_at timestamptz not null default now()
 *
 * One row per allowed request; the limit is a COUNT of rows in the window.
 *
 * Fails OPEN (allows) on query error so a transient DB issue never fully
 * blocks signup — but logs loudly.
 */
export async function checkRateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  const supabase = serviceClient();
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
