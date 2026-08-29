/**
 * send-transactional-email — the one place that sends a wallet
 * notification.
 *
 * Called only by the Postgres triggers added in
 * 20260829_email_notifications.sql, over pg_net, with the service role key
 * as the bearer token. The request body carries an event name and a row
 * id and nothing else: the trigger fires inside the money transaction and
 * has no business assembling an email, and a body that carried amounts
 * would be a second source of truth for figures the row already holds.
 *
 * So the flow is: authenticate the caller, read the row back on the
 * service key, render, log the attempt, hand it to Resend, record the
 * outcome. Every send leaves an email_log row whether it worked or not.
 *
 * Failure is deliberately terminal. There is no retry and no queue — a
 * duplicate receipt is worse than a missing one, and email_log plus
 * net._http_response is enough to find and re-send by hand.
 *
 * Deploy with the default verify_jwt: the service role key is a valid JWT,
 * so the platform check and the explicit check below both pass.
 */

import { serviceClient } from '../_shared/supabase.ts';
import { renderPurchase, type RenderedEmail } from './templates/purchase.ts';
import { renderBuybackPaid } from './templates/buyback-paid.ts';
import { renderBuybackRejected } from './templates/buyback-rejected.ts';

const RESEND_API_URL = 'https://api.resend.com/emails';

// Six months, matching credit_stars_purchase's INTERVAL '6 months'. Only
// used if the refund batch cannot be found, which should not happen.
const REFUND_VALIDITY_MS = 182 * 24 * 60 * 60 * 1000;

type EventType = 'star_purchase' | 'buyback_paid' | 'buyback_rejected';

interface Payload {
  event_type?: unknown;
  user_id?: unknown;
  reference_id?: unknown;
  reference_type?: unknown;
}

const EVENT_TYPES: readonly EventType[] = ['star_purchase', 'buyback_paid', 'buyback_rejected'];

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) {
    console.error('[send-email] SUPABASE_SERVICE_ROLE_KEY not set');
    return json({ error: 'misconfigured' }, 500);
  }

  // The triggers are the only intended caller. verify_jwt already rejects
  // an unsigned request; this rejects a *user's* valid JWT, which would
  // otherwise let any signed-in account send mail to any address on file.
  if (req.headers.get('Authorization') !== `Bearer ${serviceKey}`) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: Payload;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const eventType = body.event_type;
  const userId = body.user_id;
  const referenceId = body.reference_id;
  const referenceType = typeof body.reference_type === 'string' ? body.reference_type : null;

  if (!EVENT_TYPES.includes(eventType as EventType)) {
    return json({ error: 'unknown_event_type', detail: String(eventType) }, 400);
  }
  if (typeof userId !== 'string' || typeof referenceId !== 'string') {
    return json({ error: 'invalid_input', detail: 'user_id and reference_id are required' }, 400);
  }

  const supabase = serviceClient();

  // The address is auth.users', never anything the trigger passed in.
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
  const toEmail = userData?.user?.email;
  if (userErr || !toEmail) {
    console.error('[send-email] no address for user', userId, userErr);
    return json({ error: 'user_email_not_found', detail: userErr?.message }, 404);
  }

  let rendered: RenderedEmail;
  try {
    rendered = await render(supabase, eventType as EventType, userId, referenceId);
  } catch (err) {
    console.error('[send-email] render failed', eventType, referenceId, err);
    return json({ error: 'render_failed', detail: (err as Error).message }, 500);
  }

  // Logged before the send, so a Resend call that hangs or a worker that
  // dies mid-request still leaves a 'queued' row pointing at the event.
  const { data: log, error: logErr } = await supabase
    .from('email_log')
    .insert({
      event_type: eventType,
      user_id: userId,
      to_email: toEmail,
      subject: rendered.subject,
      reference_id: referenceId,
      reference_type: referenceType,
      payload: { event_type: eventType, user_id: userId, reference_id: referenceId },
      status: 'queued',
      attempts: 1,
    })
    .select('id')
    .single();

  if (logErr || !log) {
    console.error('[send-email] email_log insert failed', logErr);
    return json({ error: 'log_insert_failed', detail: logErr?.message }, 500);
  }

  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    console.error('[send-email] RESEND_API_KEY not set');
    await markFailed(supabase, log.id, 'RESEND_API_KEY not set');
    return json({ error: 'misconfigured' }, 500);
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [toEmail],
        reply_to: Deno.env.get('EMAIL_REPLY_TO') ?? 'support@creatorlivetech.com',
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    });

    const data = (await res.json().catch(() => null)) as { id?: string } | null;

    if (!res.ok) {
      console.error('[send-email] resend rejected', { status: res.status, data });
      await markFailed(supabase, log.id, JSON.stringify(data));
      return json({ error: 'resend_rejected', detail: data }, 502);
    }

    await supabase
      .from('email_log')
      .update({ status: 'sent', resend_id: data?.id ?? null, sent_at: new Date().toISOString() })
      .eq('id', log.id);

    return json({ success: true, log_id: log.id, resend_id: data?.id });
  } catch (err) {
    console.error('[send-email] send exception', err);
    await markFailed(supabase, log.id, (err as Error).message);
    return json({ error: 'send_exception', detail: (err as Error).message }, 500);
  }
});

/**
 * EMAIL_FROM is this function's own sender; RESEND_FROM_EMAIL is the one
 * the signup OTP already uses. Falling back to it means a project that has
 * only ever set the OTP sender still sends from a verified address rather
 * than failing at Resend.
 */
function fromAddress(): string {
  return Deno.env.get('EMAIL_FROM')
    ?? Deno.env.get('RESEND_FROM_EMAIL')
    ?? 'AURUM <noreply@creatorlivetech.com>';
}

async function render(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  eventType: EventType,
  userId: string,
  referenceId: string,
): Promise<RenderedEmail> {
  if (eventType === 'star_purchase') {
    const { data: purchase, error } = await supabase
      .from('star_purchases')
      .select('id, stars_amount, thb_amount, payment_method, completed_at, expires_at')
      .eq('id', referenceId)
      .single();
    if (error || !purchase) throw new Error(`purchase not found: ${error?.message}`);

    // Read after the credit, so this is the balance the receipt promises.
    const { data: wallet } = await supabase
      .from('stars_wallet')
      .select('total_balance')
      .eq('user_id', userId)
      .single();

    return renderPurchase({ purchase, walletBalance: wallet?.total_balance ?? 0 });
  }

  if (eventType === 'buyback_paid') {
    const { data: buyback, error } = await supabase
      .from('buyback_requests')
      .select(
        'id, star_amount, total_thb, thb_per_star, bank_name, bank_account_number, bank_account_name, processed_at',
      )
      .eq('id', referenceId)
      .single();
    if (error || !buyback) throw new Error(`buyback not found: ${error?.message}`);

    return renderBuybackPaid({ buyback });
  }

  const { data: buyback, error } = await supabase
    .from('buyback_requests')
    .select('id, star_amount, total_thb, rejection_reason, processed_at')
    .eq('id', referenceId)
    .single();
  if (error || !buyback) throw new Error(`buyback not found: ${error?.message}`);

  // admin_refund_buyback stamps the refund batch with this provider id,
  // and it commits in the same transaction as the status change that
  // queued this request — so by now it is readable.
  const { data: refundBatch } = await supabase
    .from('star_purchases')
    .select('expires_at')
    .eq('payment_provider_id', `refund_${referenceId}`)
    .maybeSingle();

  return renderBuybackRejected({
    buyback,
    refundExpiresAt: refundBatch?.expires_at ?? new Date(Date.now() + REFUND_VALIDITY_MS).toISOString(),
  });
}

// deno-lint-ignore no-explicit-any
async function markFailed(supabase: any, logId: string, error: string): Promise<void> {
  await supabase
    .from('email_log')
    .update({ status: 'failed', error: error.slice(0, 500) })
    .eq('id', logId);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
