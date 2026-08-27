/**
 * buyback-request — POST /buyback-request (Week 3 Phase D).
 *
 * The only way out of stars, at a flat 3.00 THB/star. There is no refund
 * endpoint anywhere in Week 3 and there will not be one: PromptPay is a
 * push payment, so a purchase cannot be reversed from either side, and
 * this is what a buyer who changes their mind gets instead. The gap
 * between the 11.00 THB they paid and the 3.00 they get back is the
 * policy, stated in the TOS, not a fee this code is free to tune — the
 * rate is CHECK-pinned in buyback_requests and hardcoded in
 * request_buyback.
 *
 * POST { star_amount, bank_name, bank_account_number, bank_account_name }
 *   -> { success, request_id, star_amount, total_thb, thb_per_star,
 *        status, message }
 *
 * The stars leave the wallet now; the THB is paid by hand later. A row
 * lands as 'pending' and an admin moves it on — nothing here pays anyone,
 * and there is no automatic payout in this PR.
 *
 * Deployed with verify_jwt: true. The caller's JWT decides whose wallet is
 * drained: star_amount is taken from the body, the user never is.
 */

import { preflightResponse } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { getAuthedUser } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/supabase.ts';

interface BuybackBody {
  star_amount?: unknown;
  bank_name?: unknown;
  bank_account_number?: unknown;
  bank_account_name?: unknown;
}

/** Mirrors buyback_requests' CHECK (star_amount >= 10). */
const MIN_BUYBACK_STARS = 10;

/** Thai bank account numbers run 10 digits; 15 covers the long formats. */
const MIN_ACCOUNT_DIGITS = 10;
const MAX_ACCOUNT_DIGITS = 15;

const CONFIRMATION_TH = 'คำขอ buyback ถูกสร้างเรียบร้อยแล้ว จะได้รับเงินภายใน 3-5 วันทำการ';

Deno.serve(async (req) => {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;

  const origin = req.headers.get('origin');

  try {
    const user = await getAuthedUser(req);
    if (!user) return errorResponse('invalid_credentials', origin, 'Missing or invalid bearer token');

    let body: BuybackBody;
    try {
      body = await req.json();
    } catch {
      return errorResponse('invalid_input', origin, 'Body must be JSON');
    }

    const starAmount = body.star_amount;
    if (typeof starAmount !== 'number' || !Number.isInteger(starAmount)) {
      return errorResponse('invalid_input', origin, 'star_amount must be an integer');
    }
    if (starAmount < MIN_BUYBACK_STARS) {
      return errorResponse('below_minimum', origin, `star_amount must be at least ${MIN_BUYBACK_STARS}`);
    }

    const bankName = typeof body.bank_name === 'string' ? body.bank_name.trim() : '';
    const bankAccountName = typeof body.bank_account_name === 'string' ? body.bank_account_name.trim() : '';
    const rawAccount = typeof body.bank_account_number === 'string' ? body.bank_account_number : '';

    if (bankName === '' || bankAccountName === '' || rawAccount.trim() === '') {
      return errorResponse('missing_bank_info', origin, 'bank_name, bank_account_number and bank_account_name are required');
    }

    // Bank apps and paper statements print account numbers with dashes and
    // spaces. Store the digits, so two spellings of one account cannot look
    // like two accounts to whoever pays it out.
    const accountNumber = rawAccount.replace(/\D/g, '');
    if (
      accountNumber.length < MIN_ACCOUNT_DIGITS ||
      accountNumber.length > MAX_ACCOUNT_DIGITS
    ) {
      return errorResponse(
        'invalid_account_number',
        origin,
        `bank_account_number must be ${MIN_ACCOUNT_DIGITS}-${MAX_ACCOUNT_DIGITS} digits`,
      );
    }

    const supabase = serviceClient();

    // request_buyback re-checks the balance under a row lock, which is what
    // actually makes it safe. This read is only here so the common case —
    // asking for more than you hold — comes back as insufficient_stars
    // rather than as a raised exception mapped after the fact.
    const { data: wallet, error: walletErr } = await supabase
      .from('stars_wallet')
      .select('total_balance')
      .eq('user_id', user.id)
      .maybeSingle();

    if (walletErr) {
      console.error('[buyback-request] wallet lookup failed', walletErr);
      return errorResponse('internal_error', origin, 'Wallet lookup failed');
    }
    if (!wallet) return errorResponse('wallet_not_found', origin, 'No wallet for this user');
    if (wallet.total_balance < starAmount) {
      return errorResponse(
        'insufficient_stars',
        origin,
        `balance ${wallet.total_balance}, requested ${starAmount}`,
      );
    }

    // One RPC: the request row and the FIFO deduction land together or not
    // at all. Splitting them would allow a pending payout for stars the
    // user still holds.
    const { data, error } = await supabase.rpc('request_buyback', {
      p_user_id: user.id,
      p_star_amount: starAmount,
      p_bank_name: bankName,
      p_bank_account_number: accountNumber,
      p_bank_account_name: bankAccountName,
    });

    if (error) {
      // request_buyback signals refusals by raising, so the message is the
      // machine-readable part. Anything unrecognised is a fault, not a
      // rejection, and must not be reported to the caller as their mistake.
      const message = error.message ?? '';
      if (message.includes('below_minimum')) {
        return errorResponse('below_minimum', origin, `star_amount must be at least ${MIN_BUYBACK_STARS}`);
      }
      if (message.includes('insufficient_stars')) {
        return errorResponse('insufficient_stars', origin, 'Balance changed before the request was recorded');
      }
      if (message.includes('wallet_not_found')) {
        return errorResponse('wallet_not_found', origin, 'No wallet for this user');
      }
      console.error('[buyback-request] rpc failed', error);
      return errorResponse('internal_error', origin, 'Buyback request failed');
    }

    const result = data as {
      request_id: string;
      star_amount: number;
      total_thb: number;
      thb_per_star: number;
      status: string;
      new_wallet_balance: number;
    };

    return successResponse(
      {
        success: true,
        request_id: result.request_id,
        star_amount: result.star_amount,
        total_thb: result.total_thb,
        thb_per_star: result.thb_per_star,
        status: result.status,
        new_wallet_balance: result.new_wallet_balance,
        message: CONFIRMATION_TH,
      },
      origin,
    );
  } catch (err) {
    console.error('[buyback-request] unhandled', err);
    return errorResponse('internal_error', origin);
  }
});
