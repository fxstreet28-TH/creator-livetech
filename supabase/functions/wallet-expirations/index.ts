/**
 * wallet-expirations — GET /wallet/expirations (requirements § 7).
 *
 * The full expiry schedule, where wallet-get returns only the next few
 * inline. Listed in § 7 and named in the Phase 1 objective ("GET balance,
 * transactions, expirations"); the Success Criteria's "4 Edge Functions"
 * line omits it. Built because both the objective and the API contract
 * call for it, and it is read-only — deleting the function is the whole
 * revert if it was not wanted.
 *
 * Batches are bucketed against the § 5.1 notification schedule
 * (30 / 14 / 7 / 1 days) so a client can render the same urgency banding
 * the expiry emails use, without duplicating the thresholds.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { getAuthedUser } from '../_shared/auth.ts';
import { userClient } from '../_shared/supabase.ts';

/** § 5.1 notification schedule, in days before expiry. */
const NOTIFY_THRESHOLDS = [1, 7, 14, 30] as const;

function bucketFor(daysUntil: number): string {
  for (const t of NOTIFY_THRESHOLDS) {
    if (daysUntil <= t) return `within_${t}d`;
  }
  return 'later';
}

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  try {
    const user = await getAuthedUser(req);
    if (!user) return errorResponse('invalid_credentials', origin, 'Missing or invalid bearer token');

    const { data, error } = await userClient(req)
      .from('star_purchases')
      .select('id, stars_amount, remaining_stars, thb_amount, payment_method, expires_at, created_at')
      .eq('user_id', user.id)
      .gt('remaining_stars', 0)
      .order('expires_at', { ascending: true });

    if (error) {
      console.error('[wallet-expirations] fetch failed', error);
      return errorResponse('internal_error', origin, 'Expiration fetch failed');
    }

    const now = Date.now();
    const batches = (data ?? []).map((b) => {
      const msUntil = new Date(b.expires_at as string).getTime() - now;
      const daysUntil = Math.max(Math.ceil(msUntil / 86_400_000), 0);
      return { ...b, days_until_expiry: daysUntil, bucket: bucketFor(daysUntil) };
    });

    const totals: Record<string, number> = {};
    for (const b of batches) {
      totals[b.bucket] = (totals[b.bucket] ?? 0) + (b.remaining_stars as number);
    }

    return successResponse(
      {
        batches,
        total_unexpired_stars: batches.reduce((s, b) => s + (b.remaining_stars as number), 0),
        stars_by_bucket: totals,
        next_expiry_at: batches.length > 0 ? batches[0].expires_at : null,
      },
      origin,
    );
  } catch (err) {
    console.error('[wallet-expirations] unhandled', err);
    return errorResponse('internal_error', origin);
  }
});
