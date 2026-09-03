/**
 * live-send-gift v1 — a viewer sends a น้อง Aurum gift to a live session.
 *
 * This function is deliberately thin. Everything that has to be atomic —
 * locking the session, refusing a self-gift, pricing the tier, the per-minute
 * ceilings, the FIFO spend, the creator's ledger credit, the session counters
 * — happens inside `send_live_gift` in one database transaction, because an
 * Edge Function cannot take a row lock or roll back a half-finished sequence
 * of PostgREST calls. What is left here is what an HTTP boundary is for:
 * authenticate the caller, validate and sanitise the three fields, map the
 * RPC's refusal onto a status code, and read back the balance the client
 * needs to repaint its wallet chip.
 *
 * TWO THINGS IT DOES NOT DO, ON PURPOSE
 *
 *  1. It does not broadcast. `live_gifts_broadcast` fires from the INSERT, so
 *     the event cannot exist without the row or the row without the event. A
 *     send from here would be a second source of truth and could announce a
 *     gift whose transaction later rolled back.
 *
 *  2. It does not write a chat line. The client renders one from the same
 *     `gift` event it animates, so one event stays one gift on every screen —
 *     a separate chat broadcast would arrive on its own schedule and could
 *     duplicate or contradict the overlay.
 *
 * The sender never sends a price. They send a tier id and a count, and the
 * database prices it from `gift_tiers`; a client-supplied amount would be a
 * client-supplied discount.
 *
 * verify_jwt is on, so the gateway rejects an unauthenticated call before any
 * of this runs; `getAuthedUser` returning null here means a malformed or
 * expired token got past it.
 */

import {
  getAuthedUser,
  getServiceClient,
  errorResponse,
  handleCors,
  jsonResponse,
} from '../_shared/utils.ts';

/** Guards the JSON body before it reaches a UUID column. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mirrors the CHECK on live_gifts.message. */
const MAX_MESSAGE_LENGTH = 80;

/**
 * Refusals `send_live_gift` raises, and what each one is over HTTP.
 *
 * The RPC raises its code AS the exception message, so this map is the whole
 * translation layer. An unrecognised message is a bug in the function rather
 * than a user error, and falls through to a 500 with the detail logged — not
 * to a 400, which would tell the viewer they did something wrong.
 *
 * INSUFFICIENT_STARS is a 400 rather than a 402 to match `_shared/errors.ts`,
 * where the wallet functions already answer the same condition that way.
 */
const RPC_ERROR_STATUS: Record<string, number> = {
  SESSION_NOT_LIVE: 409,
  SELF_GIFT: 403,
  TIER_INACTIVE: 409,
  QUANTITY_TOO_HIGH: 400,
  INSUFFICIENT_STARS: 400,
  RATE_LIMITED: 429,
  INVALID_INPUT: 400,
};

/**
 * Control characters and Unicode direction overrides, which must never reach
 * an overlay that renders on someone else's screen.
 *
 * C0 and C1 go first — a newline would break the single tray row this is drawn
 * into, and the rest are invisible payload. The direction overrides
 * (U+202A-U+202E, U+2066-U+2069) matter more than they look: they are not
 * decoration, they reverse the rendering of the text AROUND them, so one
 * character in a gift message can visually rewrite the sender's name beside
 * it.
 */
const UNSAFE_MESSAGE_CHARS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Trim, flatten and truncate a gift message.
 *
 * The truncation is by CODE POINT rather than by UTF-16 unit, because
 * `char_length()` in the database CHECK counts code points too — slicing with
 * `String.prototype.slice` would let an 80-character message of astral
 * characters through as 80 units and be refused by Postgres as 160.
 */
function sanitiseMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(UNSAFE_MESSAGE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  return [...cleaned].slice(0, MAX_MESSAGE_LENGTH).join('');
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    const user = await getAuthedUser(req);
    if (!user) return errorResponse('Authentication required', 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Request body must be JSON', 400, 'INVALID_INPUT');
    }

    const sessionId = body.session_id;
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
      return errorResponse('session_id must be a UUID', 400, 'INVALID_INPUT');
    }

    const tierId = body.tier_id;
    if (typeof tierId !== 'number' || !Number.isInteger(tierId) || tierId < 1 || tierId > 32767) {
      return errorResponse('tier_id must be a positive smallint', 400, 'INVALID_INPUT');
    }

    // Bounded here as well as in the database. The upper bound is the column's
    // CHECK, not any tier's max_quantity — that one is per-tier and belongs to
    // the RPC, which answers QUANTITY_TOO_HIGH carrying the tier's own limit so
    // the client can say what the limit actually is.
    const quantity = body.quantity;
    if (
      typeof quantity !== 'number' || !Number.isInteger(quantity) ||
      quantity < 1 || quantity > 999
    ) {
      return errorResponse('quantity must be an integer between 1 and 999', 400, 'INVALID_INPUT');
    }

    const message = sanitiseMessage(body.message);

    const supabase = getServiceClient();

    // Service-role, because send_live_gift is revoked from `authenticated` —
    // it moves money and credits a creator, so the only caller that may reach
    // it is one that has already established WHO is spending. That is what
    // p_sender_id carries, and it comes from the verified token above, never
    // from the request body.
    const { data, error } = await supabase.rpc('send_live_gift', {
      p_session_id: sessionId,
      p_sender_id: user.id,
      p_tier_id: tierId,
      p_quantity: quantity,
      p_message: message,
    });

    if (error) {
      const code = (error.message ?? '').trim();
      const status = RPC_ERROR_STATUS[code];

      if (status === undefined) {
        console.error('[live-send-gift] unexpected RPC failure', error);
        return errorResponse('Could not send gift', 500, 'internal_error');
      }

      // `details` carries the numbers the client needs in order to act on the
      // refusal — the balance and the price for INSUFFICIENT_STARS, the tier's
      // ceiling for QUANTITY_TOO_HIGH. It is JSON from the RPC's DETAIL;
      // anything unparseable is dropped rather than forwarded as a string the
      // client would have to guess the shape of.
      let detail: unknown = null;
      if (typeof error.details === 'string' && error.details.trim().startsWith('{')) {
        try {
          detail = JSON.parse(error.details);
        } catch {
          detail = null;
        }
      }

      return jsonResponse({ error: { message: code, code, detail } }, status);
    }

    // The RPC RETURNS public.live_gifts, so PostgREST hands back one object.
    const gift = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!gift) {
      console.error('[live-send-gift] RPC returned no row');
      return errorResponse('Could not send gift', 500, 'internal_error');
    }

    // Read after the spend rather than computed from it: the wallet chip should
    // show what the wallet says, and a number derived here would drift from it
    // the moment anything else touches the balance in the same second.
    const { data: wallet } = await supabase
      .from('stars_wallet')
      .select('total_balance')
      .eq('user_id', user.id)
      .maybeSingle();

    return jsonResponse({
      gift,
      wallet_balance: Number(wallet?.total_balance ?? 0),
    });
  } catch (err) {
    console.error('[live-send-gift] unhandled', err);
    return errorResponse('Could not send gift', 500, 'internal_error');
  }
});
