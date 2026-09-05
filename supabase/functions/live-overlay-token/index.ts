/**
 * live-overlay-token v1 — turns an OBS overlay key into a short-lived session.
 *
 * OBS's browser source is a bare Chromium: no login, no way to complete an auth
 * flow, and nobody sitting in front of it when the token expires mid-broadcast.
 * So the creator pastes a URL carrying a per-creator KEY, and this function
 * exchanges that key for a 12-hour Supabase JWT scoped to the creator's own
 * user id.
 *
 * The JWT is the whole point of the design. The overlay page then joins the
 * private `live:<session_id>` Realtime channel through the ORDINARY path —
 * `realtime.messages`, `can_watch_live_session`, the same policies every viewer
 * goes through — and is allowed on for the same reason the creator's own studio
 * is: it IS the creator. Nothing is widened for OBS, there is no second
 * entitlement ladder, and the day the watch rules change the overlay follows
 * them without being touched.
 *
 * verify_jwt is OFF, because a caller holding a JWT is exactly what this
 * function exists to fix. The key is therefore the only credential, and
 * everything below is written accordingly:
 *
 *   - The key never reaches a log line, an error message or the response.
 *   - Every refusal is the same 403 with the same body. A wrong key, an unknown
 *     session and a finished broadcast are indistinguishable from outside;
 *     telling an anonymous caller which part of its guess was wrong is how a
 *     key gets brute-forced session by session.
 *   - The exchange is rate-limited per session and IP, so the endpoint cannot
 *     be used as an oracle at volume even though 192 bits of key cannot
 *     realistically be guessed.
 *
 * REQUIRES A VAULT SECRET. `supabase_jwt_secret` must hold the project's JWT
 * secret (Dashboard → Settings → API → JWT Secret). Until it is set, this
 * function answers 503 `overlay_not_configured` — a clear "an operator has one
 * thing left to do", not a crash and not a token signed with something wrong.
 */

import { create as createJWT } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import {
  errorResponse,
  getServiceClient,
  handleCors,
  jsonResponse,
  tryGetVaultSecret,
} from '../_shared/utils.ts';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Twelve hours.
 *
 * Long enough that no realistic broadcast outlives it — the alternative is an
 * overlay that goes blank mid-stream in front of an audience, with nobody at
 * the OBS machine to refresh it. Short enough that a URL shared by accident
 * (a screen-share, a Discord paste) stops working the same day. The key behind
 * it can be rotated from /settings, which invalidates every future exchange
 * immediately.
 */
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** Exchanges allowed per session+IP per window. */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 300;

/** Every refusal, whatever the reason. See the header. */
function refuse(): Response {
  return errorResponse('Overlay link is not valid', 403, 'overlay_denied');
}

/**
 * Sliding window over `auth_rate_limits`, the ledger the signup functions
 * already use — one row per allowed request, the limit is a COUNT.
 *
 * Fails OPEN on a query error, deliberately: a transient database problem must
 * not black out a creator's overlay mid-broadcast, and the key is still
 * required either way. It logs loudly instead.
 */
async function withinRateLimit(
  supabase: ReturnType<typeof getServiceClient>,
  key: string,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString();

  const { count, error } = await supabase
    .from('auth_rate_limits')
    .select('*', { count: 'exact', head: true })
    .eq('key', key)
    .eq('action', 'overlay_token')
    .gte('created_at', windowStart);

  if (error) {
    console.error('[live-overlay-token] rate limit query failed', error);
    return true;
  }

  if ((count ?? 0) >= RATE_LIMIT_MAX) return false;

  const { error: insertError } = await supabase
    .from('auth_rate_limits')
    .insert({ key, action: 'overlay_token' });
  if (insertError) console.error('[live-overlay-token] rate limit insert failed', insertError);

  return true;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Request body must be JSON', 400, 'invalid_input');
    }

    const sessionId = body.session_id;
    const overlayKey = body.overlay_key;

    // Shape-checked before the database is touched, and refused with the same
    // 403 as everything else — a 400 here would tell a prober that its session
    // id was the malformed half.
    if (
      typeof sessionId !== 'string' || !UUID_RE.test(sessionId) ||
      typeof overlayKey !== 'string' || overlayKey.length < 16 || overlayKey.length > 128
    ) {
      return refuse();
    }

    const supabase = getServiceClient();

    // Keyed on the session AND the caller, so one creator's overlay reconnecting
    // cannot exhaust the budget of another's. The IP is best-effort behind the
    // platform's proxy; a missing one collapses to a per-session limit, which is
    // still a limit.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!(await withinRateLimit(supabase, `overlay:${sessionId}:${ip}`))) {
      return errorResponse('Too many requests', 429, 'rate_limited');
    }

    /**
     * The only question asked: does this key belong to this session's creator,
     * and is the session still running? The RPC answers with the creator's auth
     * user id, or NULL — see its comment for why it does not distinguish
     * failures.
     */
    const { data: creatorUserId, error: resolveError } = await supabase.rpc(
      'resolve_overlay_session',
      { p_session_id: sessionId, p_overlay_key: overlayKey },
    );

    if (resolveError) {
      // Logged WITHOUT the key. `resolveError` carries the message and the
      // hint, neither of which echoes the arguments.
      console.error('[live-overlay-token] resolve failed', {
        session_id: sessionId,
        code: resolveError.code,
        message: resolveError.message,
      });
      return errorResponse('Could not verify overlay link', 500, 'internal_error');
    }

    if (typeof creatorUserId !== 'string' || creatorUserId === '') return refuse();

    const jwtSecret = await tryGetVaultSecret('supabase_jwt_secret');
    if (!jwtSecret) {
      console.error('[live-overlay-token] vault secret `supabase_jwt_secret` is not set');
      return errorResponse(
        'Overlay tokens are not configured on this project',
        503,
        'overlay_not_configured',
      );
    }

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(jwtSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TOKEN_TTL_SECONDS;

    /**
     * The claims Supabase itself reads.
     *
     * `sub` becomes `auth.uid()` inside the realtime.messages policies, which is
     * the whole mechanism. `role` is the Postgres role PostgREST and Realtime
     * switch to, and `aud` must be 'authenticated' or the token is rejected as
     * being for a different audience. `iss` matches what GoTrue issues, so
     * nothing downstream has to special-case a token minted here.
     */
    const token = await createJWT(
      { alg: 'HS256', typ: 'JWT' },
      {
        sub: creatorUserId,
        role: 'authenticated',
        aud: 'authenticated',
        iss: `${Deno.env.get('SUPABASE_URL')}/auth/v1`,
        iat: now,
        exp: expiresAt,
        // Not read by Supabase — a marker for anyone reading a token in a
        // support ticket and wondering where it came from.
        overlay: true,
      },
      key,
    );

    return jsonResponse({
      access_token: token,
      expires_at: new Date(expiresAt * 1000).toISOString(),
      session_id: sessionId,
    });
  } catch (err) {
    console.error('[live-overlay-token] unhandled', err);
    return errorResponse('Could not issue overlay token', 500, 'internal_error');
  }
});
