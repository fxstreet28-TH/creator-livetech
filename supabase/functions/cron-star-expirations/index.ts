/**
 * cron-star-expirations — daily Star expiry + notification job (§ 8.10).
 *
 * Deployed with verify_jwt: false and authenticated by comparing the
 * bearer token against SUPABASE_SERVICE_ROLE_KEY, so it is callable by the
 * scheduler and by an operator holding the service key, but not by a
 * signed-in user.
 *
 * The work itself lives in run_star_expiration_cycle() in the database.
 * The pg_cron schedule calls that same function directly, so the scheduled
 * path and this manual path cannot drift apart, and the daily run needs no
 * HTTP hop and no service-role key stored in the database. This endpoint
 * is the manual trigger and the place to hang email dispatch when it is
 * built.
 *
 * NOTE: § 8.10 also calls for expiry emails. The notifications rows carry
 * email_sent / email_sent_at for exactly that, and are written here, but
 * nothing dispatches them yet — _shared/resend.ts only knows how to send a
 * verification code. Sending is a separate deliverable.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { serviceClient } from '../_shared/supabase.ts';

/** Constant-time compare so the check cannot be probed byte-by-byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (serviceKey === '' || token === '' || !safeEqual(token, serviceKey)) {
      return errorResponse('forbidden', origin, 'Service role token required');
    }

    const { data, error } = await serviceClient().rpc('run_star_expiration_cycle');

    if (error) {
      console.error('[cron-star-expirations] cycle failed', error);
      return errorResponse('internal_error', origin, error.message);
    }

    console.log('[cron-star-expirations] cycle complete', JSON.stringify(data));
    return successResponse(data, origin);
  } catch (err) {
    console.error('[cron-star-expirations] unhandled', err);
    return errorResponse('internal_error', origin);
  }
});
