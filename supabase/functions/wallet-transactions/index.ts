/**
 * wallet-transactions — GET /wallet/transactions (requirements § 7).
 *
 * Paginated Star ledger for the caller.
 *
 * Query params:
 *   limit  — default 50, clamped to 100
 *   offset — default 0
 *   type   — optional transaction_type filter ('purchase' | 'subscribe' |
 *            'ppv_unlock' | 'ppv_message' | 'tip' | 'live_gift' | 'buyback' |
 *            'expiration')
 *
 * Reads go through userClient() so transactions_select_own enforces
 * ownership in the database.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { getAuthedUser } from '../_shared/auth.ts';
import { userClient } from '../_shared/supabase.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * star_transactions.transaction_type is plain TEXT with no CHECK constraint
 * (§ 6), so an unknown filter value would silently return an empty page
 * rather than an error. Validating here turns a typo into a 400.
 */
const VALID_TYPES = new Set([
  'purchase',
  'subscribe',
  'ppv_unlock',
  'ppv_message',
  'tip',
  'live_gift',
  'buyback',
  'expiration',
]);

/** Parse a non-negative integer query param, falling back on anything invalid. */
function intParam(raw: string | null, fallback: number, max?: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return max === undefined ? n : Math.min(n, max);
}

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  try {
    const user = await getAuthedUser(req);
    if (!user) return errorResponse('invalid_credentials', origin, 'Missing or invalid bearer token');

    const params = new URL(req.url).searchParams;
    const limit = Math.max(intParam(params.get('limit'), DEFAULT_LIMIT, MAX_LIMIT), 1);
    const offset = intParam(params.get('offset'), 0);
    const type = params.get('type');

    if (type !== null && !VALID_TYPES.has(type)) {
      return errorResponse('invalid_input', origin, `Unknown transaction type: ${type}`);
    }

    let query = userClient(req)
      .from('star_transactions')
      .select(
        'id, transaction_type, stars_delta, created_at, reference_id, reference_type, creator_id, purchase_batch_ids',
        { count: 'exact' },
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type !== null) query = query.eq('transaction_type', type);

    const { data, error, count } = await query;

    if (error) {
      console.error('[wallet-transactions] fetch failed', error);
      return errorResponse('internal_error', origin, 'Transaction fetch failed');
    }

    const total = count ?? 0;

    return successResponse(
      {
        transactions: data ?? [],
        total_count: total,
        has_more: offset + (data?.length ?? 0) < total,
        limit,
        offset,
      },
      origin,
    );
  } catch (err) {
    console.error('[wallet-transactions] unhandled', err);
    return errorResponse('internal_error', origin);
  }
});
