/**
 * wallet-get — GET /wallet (requirements § 7, Stars Wallet).
 *
 * Returns the caller's Star balance plus the next batches due to expire,
 * which is what the wallet screen needs in one round trip (§ 5.1: "Wallet
 * UI shows total balance + upcoming expirations").
 *
 * Reads go through userClient(), so the Phase B RLS policies
 * (wallet_select_own, purchases_select_own) are enforced by the database;
 * the explicit user_id filters are a second layer, not the only one.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { getAuthedUser } from '../_shared/auth.ts';
import { userClient } from '../_shared/supabase.ts';

/** How many upcoming expiry batches the wallet screen shows inline. */
const UPCOMING_EXPIRATION_LIMIT = 10;

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  try {
    const user = await getAuthedUser(req);
    if (!user) return errorResponse('invalid_credentials', origin, 'Missing or invalid bearer token');

    const supabase = userClient(req);

    const { data: wallet, error: walletErr } = await supabase
      .from('stars_wallet')
      .select('total_balance, total_purchased, total_spent, total_expired, total_bought_back, updated_at')
      .eq('user_id', user.id)
      .maybeSingle();

    if (walletErr) {
      console.error('[wallet-get] wallet fetch failed', walletErr);
      return errorResponse('internal_error', origin, 'Wallet fetch failed');
    }

    const { data: expirations, error: expErr } = await supabase
      .from('star_purchases')
      .select('id, remaining_stars, expires_at, thb_amount')
      .eq('user_id', user.id)
      .gt('remaining_stars', 0)
      .order('expires_at', { ascending: true })
      .limit(UPCOMING_EXPIRATION_LIMIT);

    if (expErr) {
      console.error('[wallet-get] expirations fetch failed', expErr);
      return errorResponse('internal_error', origin, 'Expirations fetch failed');
    }

    return successResponse(
      {
        // The signup trigger guarantees a wallet row, so a miss here means a
        // user created before it existed. Zeroes are the truthful answer and
        // keep the wallet screen renderable; a 500 would not be.
        wallet: wallet ?? {
          total_balance: 0,
          total_purchased: 0,
          total_spent: 0,
          total_expired: 0,
          total_bought_back: 0,
          updated_at: null,
        },
        upcoming_expirations: expirations ?? [],
      },
      origin,
    );
  } catch (err) {
    console.error('[wallet-get] unhandled', err);
    return errorResponse('internal_error', origin);
  }
});
