/**
 * admin-credit-stars — manual Star credit, admin only (Phase D).
 *
 * Exists so wallet behaviour and the expiration cron can be exercised
 * before Stripe/OxaPay land in Week 3-4. Credits land as a normal
 * star_purchases batch with payment_method 'manual_admin', so they age
 * out on the ordinary six-month schedule and are indistinguishable to the
 * rest of the system from a real purchase.
 *
 * POST { target_user_email, stars_amount, reason }
 *   -> { success, purchase_id, new_wallet_balance, expires_at }
 *
 * Runs on the service key throughout: the admin check, the user lookup and
 * the credit RPC are all revoked from anon/authenticated.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { getAuthedUser } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/supabase.ts';
import {
  addStarsToWallet,
  MAX_PURCHASE_STARS,
  MIN_PURCHASE_STARS,
  THB_PER_STAR,
} from '../_shared/stars.ts';

interface CreditBody {
  target_user_email?: unknown;
  stars_amount?: unknown;
  reason?: unknown;
}

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  try {
    const caller = await getAuthedUser(req);
    if (!caller) return errorResponse('invalid_credentials', origin, 'Missing or invalid bearer token');

    const supabase = serviceClient();

    const { data: isAdmin, error: adminErr } = await supabase.rpc('is_admin', { p_user_id: caller.id });
    if (adminErr) {
      console.error('[admin-credit-stars] admin check failed', adminErr);
      return errorResponse('internal_error', origin, 'Admin check failed');
    }
    if (isAdmin !== true) {
      return errorResponse('forbidden', origin, 'Admin access required');
    }

    let body: CreditBody;
    try {
      body = await req.json();
    } catch {
      return errorResponse('invalid_input', origin, 'Body must be JSON');
    }

    const email = typeof body.target_user_email === 'string' ? body.target_user_email.trim() : '';
    if (email === '') return errorResponse('invalid_input', origin, 'target_user_email is required');

    const stars = body.stars_amount;
    if (typeof stars !== 'number' || !Number.isInteger(stars)) {
      return errorResponse('invalid_input', origin, 'stars_amount must be an integer');
    }
    // star_purchases carries CHECK (stars_amount BETWEEN 100 AND 10000);
    // checking here turns a constraint violation into a readable 400.
    if (stars < MIN_PURCHASE_STARS || stars > MAX_PURCHASE_STARS) {
      return errorResponse(
        'invalid_input',
        origin,
        `stars_amount must be between ${MIN_PURCHASE_STARS} and ${MAX_PURCHASE_STARS}`,
      );
    }

    const reason = typeof body.reason === 'string' ? body.reason : null;

    const { data: targetId, error: lookupErr } = await supabase.rpc('admin_find_user_by_email', {
      p_email: email,
    });
    if (lookupErr) {
      console.error('[admin-credit-stars] lookup failed', lookupErr);
      return errorResponse('internal_error', origin, 'User lookup failed');
    }
    if (!targetId) return errorResponse('not_found', origin, `No user with email ${email}`);

    const result = await addStarsToWallet(
      supabase,
      targetId as string,
      stars,
      stars * THB_PER_STAR,
      'manual_admin',
      `admin_${crypto.randomUUID()}`,
      { reason, credited_by: caller.id, credited_by_email: caller.email },
    );

    if (!result.success) {
      // Business rejections (wallet cap, duplicate provider id) are the
      // caller's problem, not a server fault.
      return errorResponse('invalid_input', origin, result.error ?? 'Credit failed');
    }

    return successResponse(
      {
        success: true,
        purchase_id: result.purchase_id,
        new_wallet_balance: result.new_wallet_balance,
        expires_at: result.expires_at,
        target_user_id: targetId,
      },
      origin,
    );
  } catch (err) {
    console.error('[admin-credit-stars] unhandled', err);
    return errorResponse('internal_error', origin);
  }
});
