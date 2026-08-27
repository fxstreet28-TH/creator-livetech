/**
 * stripe-webhook — POST /stripe-webhook (Week 3 Phase C).
 *
 * The only path by which stars are credited for money. Stripe posts here
 * when a PromptPay PaymentIntent settles, fails, or is cancelled; a
 * succeeded event turns into a credit_stars_purchase call and a
 * star_purchases batch.
 *
 * Deploy with verify_jwt DISABLED — Stripe sends its own signature, not a
 * Supabase JWT:
 *
 *   supabase functions deploy stripe-webhook --no-verify-jwt
 *
 * Two things stand in for that JWT. First the signature: an unsigned or
 * badly signed request is rejected before anything is read out of the body,
 * so the endpoint being public does not make it callable. Second the
 * stripe_events ledger: every delivery is recorded under Stripe's own event
 * id, which is a primary key, so a redelivery cannot credit the same
 * payment twice. credit_stars_purchase is independently idempotent on the
 * PaymentIntent id, which is the backstop if this one is ever bypassed.
 *
 * There is no refund or dispute handling here, deliberately. PromptPay is a
 * push payment: the buyer pushes THB from their own bank app, and their
 * bank cannot pull it back. Buyback at 3.00 THB/star is the only exit.
 */

import Stripe from 'stripe';
import { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '../_shared/supabase.ts';
import { latestChargeId, parseStarMetadata, stripeClient, stripeCryptoProvider } from '../_shared/stripe.ts';
import { addStarsToWallet } from '../_shared/stars.ts';

type ProcessingStatus = 'processed' | 'failed' | 'ignored';

/**
 * Outcome of handling one event.
 *
 * `retry` is what separates a failure Stripe should redeliver (the database
 * was unreachable) from one it should not (the credit was refused and will
 * be refused identically forever). Only the first gets a 5xx.
 */
interface Outcome {
  status: ProcessingStatus;
  result: Record<string, unknown>;
  retry?: boolean;
}

/** Stripe reads the status, not the body; the text is for our own logs. */
function reply(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

async function markProcessed(
  supabase: SupabaseClient,
  eventId: string,
  status: ProcessingStatus,
  result: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('stripe_events')
    .update({ processing_status: status, processing_result: result })
    .eq('event_id', eventId);

  // Losing the outcome does not undo the credit, so this never changes what
  // is returned to Stripe — but it does leave the ledger lying, so it is
  // logged loudly.
  if (error) console.error('[stripe-webhook] mark failed', eventId, status, error);
}

/**
 * A paid PaymentIntent: credit the stars.
 *
 * The credit is driven by the intent's metadata rather than by our own
 * star_payment_intents row, so a delivery is handled correctly even if that
 * row was never written. thb comes from amount_received — what Stripe
 * actually collected — not from the quoted price, so star_purchases records
 * the money that moved and its generated retail_thb_per_star cannot
 * disagree with it.
 */
async function handlePaymentSucceeded(
  supabase: SupabaseClient,
  pi: Stripe.PaymentIntent,
): Promise<Outcome> {
  const meta = parseStarMetadata(pi.metadata);
  if (!meta) {
    // Not one of ours: another product on the same account, or a
    // `stripe trigger` test event, which carries no metadata.
    return { status: 'ignored', result: { reason: 'not_a_star_purchase', payment_intent: pi.id } };
  }

  const amountSatang = pi.amount_received ?? pi.amount;
  const thb = amountSatang / 100;
  const chargeId = latestChargeId(pi);

  const credit = await addStarsToWallet(
    supabase,
    meta.user_id,
    meta.stars,
    thb,
    'stripe_promptpay',
    pi.id,
    {
      retail_thb_per_star: meta.retail_thb_per_star,
      internal_thb_per_star: meta.internal_thb_per_star,
      pricing_config_id: meta.pricing_config_id,
      source: meta.source,
      stripe_payment_intent_id: pi.id,
      stripe_charge_id: chargeId,
      amount_satang: amountSatang,
      currency: pi.currency,
      livemode: pi.livemode,
    },
  );

  if (!credit.success) {
    console.error('[stripe-webhook] credit failed', pi.id, credit.error);
    return {
      status: 'failed',
      result: {
        reason: 'credit_failed',
        error: credit.error,
        payment_intent: pi.id,
        user_id: meta.user_id,
        stars: meta.stars,
      },
      // A refused credit (wallet cap, missing wallet) refuses the same way
      // on every redelivery and needs a person. A transport failure is
      // exactly what redelivery is for.
      retry: credit.transport_error === true,
    };
  }

  // Bookkeeping, after the money. A failure here leaves the intent row
  // stale but the wallet correct, which is the right way round.
  const { error: intentErr } = await supabase
    .from('star_payment_intents')
    .update({
      status: 'succeeded',
      stripe_charge_id: chargeId,
      star_purchase_id: credit.purchase_id ?? null,
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_payment_intent_id', pi.id);

  if (intentErr) console.error('[stripe-webhook] intent row update failed', pi.id, intentErr);

  return {
    status: 'processed',
    result: {
      payment_intent: pi.id,
      user_id: meta.user_id,
      stars: meta.stars,
      thb,
      purchase_id: credit.purchase_id ?? null,
      new_wallet_balance: credit.new_wallet_balance ?? null,
      idempotent_replay: credit.idempotent_replay === true,
      intent_row_updated: !intentErr,
    },
  };
}

/**
 * A failed or cancelled PaymentIntent: record why, credit nothing.
 *
 * A PromptPay QR that goes unscanned expires and lands here. There is no
 * money to reverse and no wallet to touch — only the intent row moves.
 */
async function handlePaymentNotPaid(
  supabase: SupabaseClient,
  pi: Stripe.PaymentIntent,
  status: 'failed' | 'canceled',
): Promise<Outcome> {
  const reason = status === 'failed'
    ? pi.last_payment_error?.message ?? 'payment_failed'
    : pi.cancellation_reason ?? 'canceled';

  const { data, error } = await supabase
    .from('star_payment_intents')
    .update({ status, failure_reason: reason, updated_at: new Date().toISOString() })
    .eq('stripe_payment_intent_id', pi.id)
    .select('id');

  if (error) {
    console.error('[stripe-webhook] intent row update failed', pi.id, error);
    return {
      status: 'failed',
      result: { reason: 'intent_update_failed', error: error.message, payment_intent: pi.id },
      retry: true,
    };
  }

  if (!data || data.length === 0) {
    return { status: 'ignored', result: { reason: 'unknown_payment_intent', payment_intent: pi.id } };
  }

  return { status: 'processed', result: { payment_intent: pi.id, status, failure_reason: reason } };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply('method_not_allowed', 405);

  const signature = req.headers.get('stripe-signature');
  if (!signature) return reply('missing_signature', 400);

  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set');
    return reply('not_configured', 500);
  }

  // The raw body, byte for byte. Parsing it first and re-serialising would
  // change the bytes the signature was computed over.
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripeClient().webhooks.constructEventAsync(
      raw,
      signature,
      secret,
      undefined,
      stripeCryptoProvider(),
    );
  } catch (err) {
    // No detail beyond the message: the body is unverified at this point,
    // so none of it belongs in our logs.
    console.error('[stripe-webhook] signature invalid', err instanceof Error ? err.message : err);
    return reply('invalid_signature', 400);
  }

  const supabase = serviceClient();

  // Claim the event before doing any work. The primary key is Stripe's own
  // event id, so a concurrent or later redelivery collides here rather than
  // crediting a second time.
  const { error: insertError } = await supabase.from('stripe_events').insert({
    event_id: event.id,
    event_type: event.type,
    livemode: event.livemode,
    payload: event as unknown as Record<string, unknown>,
    processing_status: 'received',
  });

  if (insertError) {
    if (insertError.code !== '23505') {
      // Not a duplicate — the ledger is unavailable, and without it this
      // delivery cannot be made idempotent. 500 so Stripe brings it back.
      console.error('[stripe-webhook] event insert failed', event.id, insertError);
      return reply('event_insert_failed', 500);
    }

    const { data: existing } = await supabase
      .from('stripe_events')
      .select('processing_status')
      .eq('event_id', event.id)
      .maybeSingle();

    const previous = existing?.processing_status;
    if (previous === 'processed' || previous === 'ignored') {
      return reply('ok_duplicate', 200);
    }

    // Left 'received' (a delivery that died mid-flight) or 'failed' (one
    // whose credit could not be made). Both are worth another attempt:
    // credit_stars_purchase is idempotent on the PaymentIntent id, so a
    // retry cannot double-credit, and refusing to retry would make the
    // ledger row that exists to prevent double credits into the thing that
    // permanently blocks a legitimate one.
    console.warn('[stripe-webhook] reprocessing event', event.id, 'previous status', previous);
  }

  let outcome: Outcome;
  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        outcome = await handlePaymentSucceeded(supabase, event.data.object as Stripe.PaymentIntent);
        break;
      case 'payment_intent.payment_failed':
        outcome = await handlePaymentNotPaid(supabase, event.data.object as Stripe.PaymentIntent, 'failed');
        break;
      case 'payment_intent.canceled':
        outcome = await handlePaymentNotPaid(supabase, event.data.object as Stripe.PaymentIntent, 'canceled');
        break;
      default:
        // Everything else — payment_intent.created, .processing,
        // .requires_action — is recorded and acknowledged. Returning
        // anything but 200 would have Stripe redeliver events we have no
        // handler for.
        outcome = { status: 'ignored', result: { reason: 'unhandled_type', event_type: event.type } };
    }
  } catch (err) {
    console.error('[stripe-webhook] handler threw', event.id, event.type, err);
    outcome = {
      status: 'failed',
      result: { reason: 'handler_exception', error: err instanceof Error ? err.message : String(err) },
      retry: true,
    };
  }

  await markProcessed(supabase, event.id, outcome.status, outcome.result);

  if (outcome.status === 'failed' && outcome.retry) return reply('processing_failed', 500);
  return reply(`ok_${outcome.status}`, 200);
});
