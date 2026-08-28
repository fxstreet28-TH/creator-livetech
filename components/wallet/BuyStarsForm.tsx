'use client';

/**
 * The star purchase flow, end to end.
 *
 * Four states, in order: pick an amount, wait while the PaymentIntent is
 * opened, scan the QR, done. Backwards only by starting over.
 *
 * The money path, and where each step's authority lives:
 *
 *   1. create-payment-intent prices the purchase off star_pricing_config and
 *      opens a Stripe PaymentIntent. It — not this component — is what
 *      enforces the amount bounds and the wallet cap. The client-side checks
 *      below exist to keep a doomed request from being sent, not to decide
 *      whether it is allowed.
 *   2. Stripe.js confirms it with `handleActions: false`, which is what makes
 *      Stripe hand back `next_action` instead of taking the screen over with
 *      its own hosted QR modal. Rendering our own QR is the whole reason.
 *   3. stripe-webhook credits the stars when the bank confirms. Nothing here
 *      credits anything, and nothing here may claim success before the
 *      balance actually moves.
 *
 * Which is why completion is detected by watching stars_wallet over Realtime
 * rather than by polling create-payment-intent: the balance rising is the
 * only fact that means the stars exist.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { getStripe, isStripeConfigured } from '@/lib/stripe/client';
import { PROMPTPAY_DEFAULT_TTL_MS, extractPromptPayQr } from '@/lib/stripe/promptpay';
import { invokeEdge, type EdgeError } from '@/lib/wallet/invoke';
import { useActivePricing } from '@/lib/hooks/useActivePricing';
import { useWalletSummary } from '@/lib/hooks/useWalletSummary';
import {
  BUYBACK_THB_PER_STAR,
  MAX_PURCHASE_STARS,
  MAX_WALLET_STARS,
  MIN_PURCHASE_STARS,
  STAR_PRESETS,
} from '@/lib/constants/stars';
import { formatStars, formatThbRate, formatThbWithUnit } from '@/lib/wallet/format';
import { StarAmountSelector, type AmountSource } from './StarAmountSelector';
import { PromptPayQR } from './PromptPayQR';

interface CreateIntentResponse {
  client_secret: string;
  payment_intent_id: string;
  stars: number;
  amount_thb: number;
  retail_thb_per_star: number;
  currency: string;
  status: string;
}

interface QrState {
  imageUrlPng: string;
  hostedInstructionsUrl: string | null;
  expiresAt: number;
  stars: number;
  amountThb: number;
  /** Which purchase this QR is for. The only handle on "did THIS one land". */
  paymentIntentId: string;
}

type Phase = 'form' | 'creating' | 'awaiting_payment' | 'success';

/**
 * How long to trust Realtime before offering the manual check.
 *
 * Not a timeout: the subscription stays live past it, and a late event still
 * lands. It is the point at which silence stops being normal and the buyer
 * deserves a button rather than a spinner — a PromptPay confirmation is
 * usually seconds, so a minute of nothing means something is worth checking.
 */
const REALTIME_GRACE_MS = 60_000;

/** How often the QR screen re-reads its own PaymentIntent. See the poll effect. */
const INTENT_POLL_MS = 5_000;

/** Default preset the form opens on: the highlighted tile. */
const DEFAULT_STARS = STAR_PRESETS.find((preset) => preset.highlighted)?.stars ?? MIN_PURCHASE_STARS;

export function BuyStarsForm() {
  const pricing = useActivePricing();
  const wallet = useWalletSummary();

  const [stars, setStars] = useState<number>(DEFAULT_STARS);
  const [source, setSource] = useState<AmountSource>('preset');
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<EdgeError | null>(null);
  const [qr, setQr] = useState<QrState | null>(null);
  const [waitingForConfirmation, setWaitingForConfirmation] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [creditedBalance, setCreditedBalance] = useState<number | null>(null);

  const channelRef = useRef<RealtimeChannel | null>(null);

  const retail = pricing.retailThbPerStar;
  const totalThb = retail === null ? null : stars * retail;
  const balanceKnown = wallet.balanceKnown;

  /**
   * Client-side gate on the amount. Every rule here is re-checked by
   * create-payment-intent; the copy is duplicated from _shared/errors.ts so
   * a rejection the backend would issue reads identically whether it was
   * caught here or there.
   */
  function validate(amount: number, balance: number, knownBalance: boolean): string | null {
    if (!Number.isInteger(amount) || amount <= 0) return 'กรุณากรอกจำนวน Stars';
    if (amount < MIN_PURCHASE_STARS || amount > MAX_PURCHASE_STARS) {
      return `จำนวน stars ต้องอยู่ระหว่าง ${formatStars(MIN_PURCHASE_STARS)}-${formatStars(MAX_PURCHASE_STARS)}`;
    }
    // Only meaningful against a balance we actually have. If wallet-get
    // failed, this arm would be comparing the purchase against a placeholder
    // zero and would wave through an amount that breaches the cap;
    // create-payment-intent re-checks it either way and is the authority.
    if (knownBalance && balance + amount > MAX_WALLET_STARS) {
      return 'ยอด stars ในกระเป๋าจะเกินขีดจำกัด';
    }
    return null;
  }

  const validationError = validate(stars, wallet.balance, balanceKnown);

  /** Tear the Realtime channel down. Safe to call more than once. */
  const closeChannel = useCallback(() => {
    const channel = channelRef.current;
    if (!channel) return;
    channelRef.current = null;
    // removeChannel is async — it awaits a leave round trip before dropping
    // the channel from the client's registry — and it is deliberately not
    // awaited here, because every caller is a synchronous cleanup path. That
    // is exactly why the topic below carries the PaymentIntent id: while this
    // removal is in flight the old topic is still registered, and
    // supabase.channel() returns an EXISTING channel for a topic it already
    // holds rather than making a new one. A fixed topic would hand the next
    // attempt the dying channel, whose subscribe() is a no-op once it is not
    // closed — a QR that silently never confirms.
    getBrowserSupabase().removeChannel(channel);
  }, []);

  /**
   * Whether this component is still mounted.
   *
   * handleSubmit awaits four round trips before it subscribes, and the user
   * can leave during them — that is a normal thing to do while a payment is
   * being set up. Without this, the unmount cleanup runs while channelRef is
   * still null, then the continuation resumes and opens a subscription that
   * no cleanup path can ever reach: a WebSocket leak for the life of the SPA
   * session, one per abandoned attempt.
   */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      closeChannel();
    };
  }, [closeChannel]);

  /**
   * The 60-second grace period, armed only while a QR is on screen.
   *
   * The effect only arms the timer; the flag is cleared by whoever leaves
   * this phase (handleSubmit on the way in, reset() and finishSuccess on the
   * way out). Clearing it here instead would be a setState in an effect body,
   * and would re-arm on every unrelated re-render.
   */
  useEffect(() => {
    if (phase !== 'awaiting_payment') return;
    const timer = window.setTimeout(() => setWaitingForConfirmation(true), REALTIME_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [phase, qr?.expiresAt]);

  /**
   * Has THIS PaymentIntent been paid?
   *
   * A rising balance is not the answer, and using it as the answer was a real
   * bug: stars_wallet goes up for any credit, so a buyer who abandoned one QR
   * and started a second could pay the first, and the second screen would
   * report success for a payment nobody made — then tear down its
   * subscription and never notice the payment that was actually pending.
   * admin-credit-stars landing mid-QR did the same thing.
   *
   * star_payment_intents.status is the only fact that names this purchase.
   * The row is readable from the browser (star_payment_intents_read_own plus
   * a SELECT grant to authenticated), and only the webhook ever writes it.
   */
  const isIntentPaid = useCallback(async (paymentIntentId: string): Promise<boolean> => {
    const { data, error } = await getBrowserSupabase()
      .from('star_payment_intents')
      .select('status')
      .eq('stripe_payment_intent_id', paymentIntentId)
      .maybeSingle();

    if (error || !data) return false;
    return data.status === 'succeeded';
  }, []);

  /** Confirmed paid: read the fresh balance and show the success state. */
  const finishSuccess = useCallback(async () => {
    const { data } = await invokeEdge<{ wallet: { total_balance: number } }>(
      getBrowserSupabase(),
      'wallet-get',
      { method: 'GET' },
    );
    if (!mountedRef.current) return;

    const balance = Number(data?.wallet?.total_balance ?? NaN);
    closeChannel();
    setCreditedBalance(Number.isFinite(balance) ? balance : null);
    setWaitingForConfirmation(false);
    setPhase('success');
  }, [closeChannel]);

  /** Check the intent, and settle if it has been paid. */
  const checkIntent = useCallback(
    async (paymentIntentId: string) => {
      if (!mountedRef.current) return false;
      const paid = await isIntentPaid(paymentIntentId);
      if (!paid || !mountedRef.current) return false;
      await finishSuccess();
      return true;
    },
    [isIntentPaid, finishSuccess],
  );

  /**
   * Backstop poll while a QR is on screen.
   *
   * Realtime is the fast path, but it has quiet failure modes — a dropped
   * socket, a channel that came back CHANNEL_ERROR, the table missing from
   * the publication — and every one of them looks exactly like "the buyer has
   * not paid yet". A five-second read of one indexed row is cheap enough that
   * the screen should not depend on the socket to notice money arriving.
   */
  useEffect(() => {
    if (phase !== 'awaiting_payment' || !qr) return;
    const paymentIntentId = qr.paymentIntentId;
    const timer = window.setInterval(() => {
      void checkIntent(paymentIntentId);
    }, INTENT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase, qr, checkIntent]);

  /** Manual re-check behind the "รีเฟรช" button. */
  async function handleManualRefresh() {
    if (!qr) return;
    setRefreshing(true);
    await checkIntent(qr.paymentIntentId);
    if (mountedRef.current) setRefreshing(false);
  }

  function subscribeToWallet(userId: string, paymentIntentId: string) {
    closeChannel();

    // Topic is unique per attempt — see closeChannel above for why a fixed
    // one would eventually hand back a dead channel.
    const channel = getBrowserSupabase()
      .channel(`wallet:${userId}:${paymentIntentId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'stars_wallet',
          filter: `user_id=eq.${userId}`,
        },
        // The event is only a prompt to go and check; it is deliberately not
        // trusted to mean this purchase landed. See isIntentPaid.
        () => {
          void checkIntent(paymentIntentId);
        },
      )
      .subscribe((status) => {
        // Without a callback these statuses are swallowed and a broken
        // channel is indistinguishable from an unpaid QR. Surfacing the
        // waiting notice early gets the manual button in front of the user
        // instead of making them sit out the full grace period.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn('[BuyStarsForm] realtime channel status', status);
          if (mountedRef.current) setWaitingForConfirmation(true);
        }
      });

    channelRef.current = channel;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // No automatic retry anywhere in this handler, and none on failure: each
    // call to create-payment-intent opens a real PaymentIntent at Stripe, so
    // a retry the user did not ask for leaves an orphan intent behind that
    // could still be paid.
    if (phase !== 'form') return;
    if (validationError || retail === null) return;

    setError(null);
    setPhase('creating');

    const supabase = getBrowserSupabase();

    const { data: session } = await supabase.auth.getSession();
    const user = session.session?.user ?? null;
    if (!user) {
      setError({
        code: 'invalid_credentials',
        message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
      });
      setPhase('form');
      return;
    }

    const stripe = await getStripe();
    if (!stripe) {
      // Checked before create-payment-intent rather than after: an intent
      // opened for a screen that cannot render its QR is an orphan.
      setError({
        code: 'stripe_unavailable',
        message: 'ระบบชำระเงินไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง',
        detail: isStripeConfigured()
          ? 'Stripe.js failed to load'
          : 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set in this build',
      });
      setPhase('form');
      return;
    }

    const { data: intent, error: intentError } = await invokeEdge<CreateIntentResponse>(
      supabase,
      'create-payment-intent',
      { body: { stars, source } },
    );

    if (intentError || !intent) {
      // The backend's Thai message is rendered as-is: errors.ts is where that
      // copy is maintained, and restating it here would let the two drift.
      setError(intentError ?? { code: 'internal_error', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
      setPhase('form');
      return;
    }

    // Option A for the missing billing_details.email: attach it at confirm
    // time rather than at PaymentIntent creation. The Stripe account requires
    // an email on PromptPay, and doing it here keeps create-payment-intent
    // from having to know about the auth session — it also gives the buyer
    // the address their Stripe receipt goes to.
    const { error: stripeError, paymentIntent } = await stripe.confirmPromptPayPayment(
      intent.client_secret,
      { payment_method: { billing_details: { email: user.email ?? '' } } },
      // Without this, Stripe.js opens its own QR modal and this component's
      // QR, countdown and realtime wiring never run.
      { handleActions: false },
    );

    if (stripeError) {
      setError({
        code: 'stripe_error',
        message: stripeError.message ?? 'ไม่สามารถสร้างรายการชำระเงินได้',
        detail: stripeError.code ?? null,
      });
      setPhase('form');
      return;
    }

    const qrCode = extractPromptPayQr(paymentIntent);
    if (!qrCode) {
      setError({
        code: 'stripe_error',
        message: 'ไม่สามารถแสดง QR ได้ กรุณาลองใหม่',
        detail: `next_action carried no promptpay_display_qr_code (status ${paymentIntent?.status})`,
      });
      setPhase('form');
      return;
    }

    // Everything above this line was awaited, and the user can leave during
    // those round trips. Subscribing after that would open a channel the
    // unmount cleanup has already run past and can never close.
    //
    // The PaymentIntent that was opened at Stripe is deliberately left alone:
    // cancelling it needs a server-side call this PR does not have
    // (cancel-payment-intent is the deferred follow-up), and an unpaid
    // PromptPay intent expires on its own. The buyer's own bank app is the
    // only thing that could still pay it, and stripe-webhook credits from
    // metadata regardless of whether this screen is still open — so the
    // stars are not lost either way.
    if (!mountedRef.current) return;

    setWaitingForConfirmation(false);
    subscribeToWallet(user.id, intent.payment_intent_id);

    setQr({
      imageUrlPng: qrCode.imageUrlPng,
      hostedInstructionsUrl: qrCode.hostedInstructionsUrl,
      expiresAt: qrCode.expiresAt ?? Date.now() + PROMPTPAY_DEFAULT_TTL_MS,
      stars: intent.stars,
      amountThb: Number(intent.amount_thb),
      paymentIntentId: intent.payment_intent_id,
    });
    setPhase('awaiting_payment');
  }

  /** Back to a clean form. Used by "ซื้ออีก" and by QR expiry. */
  function reset(message: EdgeError | null = null) {
    closeChannel();
    setQr(null);
    setCreditedBalance(null);
    setWaitingForConfirmation(false);
    setError(message);
    setPhase('form');
    wallet.refresh();
  }

  const handleExpired = useCallback(() => {
    // The intent stays open at Stripe until it expires there too; we simply
    // stop offering a QR that a bank app would now reject. A fresh purchase
    // means a fresh intent, which is the only safe way to re-issue one.
    setPhase('form');
    setQr(null);
    closeChannel();
    setError({
      code: 'qr_expired',
      message: 'QR หมดอายุแล้ว กรุณาสร้างรายการใหม่',
    });
  }, [closeChannel]);

  // ---------------------------------------------------------------- render

  if (pricing.loading || wallet.loading) {
    return <BuyStarsSkeleton />;
  }

  if (pricing.error || retail === null) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-center">
        <p className="text-sm text-red-100">
          {pricing.error?.message ?? 'ระบบราคาไม่พร้อมใช้งาน กรุณาลองใหม่'}
        </p>
        <button
          type="button"
          onClick={pricing.reload}
          className="mt-4 min-h-11 rounded-xl border border-red-300/40 px-5 py-2.5 text-sm font-semibold text-red-100 transition hover:bg-red-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          ลองใหม่
        </button>
      </div>
    );
  }

  if (phase === 'success') {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-8 text-center">
        <CheckCircle2 size={56} className="text-emerald-300" aria-hidden />
        <h2 className="text-xl font-bold text-white" role="status">
          ซื้อสำเร็จ! ได้รับ {formatStars(qr?.stars ?? stars)} Stars
        </h2>
        {creditedBalance !== null && (
          <p className="text-sm text-white/70">
            ยอดคงเหลือ: {formatStars(creditedBalance)} Stars
          </p>
        )}
        <div className="mt-2 flex w-full flex-col gap-3 sm:flex-row">
          <Link
            href="/wallet"
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            กลับไปที่ Wallet
          </Link>
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            ซื้ออีก
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'awaiting_payment' && qr) {
    return (
      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-6">
        <PromptPayQR
          imageUrlPng={qr.imageUrlPng}
          hostedInstructionsUrl={qr.hostedInstructionsUrl}
          stars={qr.stars}
          amountThb={qr.amountThb}
          expiresAt={qr.expiresAt}
          onExpired={handleExpired}
          waitingForConfirmation={waitingForConfirmation}
          onManualRefresh={handleManualRefresh}
          refreshing={refreshing}
        />
        <button
          type="button"
          onClick={() => reset()}
          className="mt-6 min-h-11 w-full rounded-xl border border-white/10 px-4 py-3 text-sm text-white/50 transition hover:bg-white/5 hover:text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          ยกเลิกและเลือกจำนวนใหม่
        </button>
      </div>
    );
  }

  const busy = phase === 'creating';

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100"
        >
          {error.message}
        </div>
      )}

      {!wallet.loading && wallet.error && (
        <div
          role="alert"
          className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100"
        >
          <p>โหลดยอดคงเหลือไม่สำเร็จ — ยังซื้อได้ตามปกติ</p>
          <button
            type="button"
            onClick={wallet.refresh}
            className="mt-3 min-h-11 rounded-xl border border-amber-300/40 px-4 py-2 text-sm font-semibold text-amber-100 transition hover:bg-amber-400/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            ลองโหลดใหม่
          </button>
        </div>
      )}

      <StarAmountSelector
        value={stars}
        onChange={(nextStars, nextSource) => {
          setStars(nextStars);
          setSource(nextSource);
          setError(null);
        }}
        retailThbPerStar={retail}
        validationError={validationError}
        disabled={busy}
      />

      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-white/60">ราคาต่อ Star</span>
          <span className="font-medium text-white">{formatThbRate(retail)}</span>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-white/8 pt-3">
          <span className="text-sm text-white/60">ยอดชำระทั้งหมด</span>
          <span className="text-xl font-bold text-white">
            {totalThb === null ? '—' : formatThbWithUnit(totalThb)}
          </span>
        </div>
        <p className="mt-3 text-xs text-white/40">
          {balanceKnown
            ? `ยอดคงเหลือปัจจุบัน ${formatStars(wallet.balance)} Stars`
            : 'ไม่ทราบยอดคงเหลือ'}{' '}
          · เก็บได้สูงสุด {formatStars(MAX_WALLET_STARS)} Stars
        </p>
      </div>

      <button
        type="submit"
        disabled={busy || validationError !== null}
        className="inline-flex min-h-[3.25rem] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-purple-500 to-pink-500 px-6 py-4 text-base font-extrabold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:shadow-none"
      >
        {busy ? (
          <>
            <Loader2 size={18} className="animate-spin" aria-hidden />
            กำลังสร้าง QR...
          </>
        ) : (
          <>
            <Sparkles size={18} aria-hidden />
            ซื้อ {formatStars(stars)} Stars — {totalThb === null ? '—' : formatThbWithUnit(totalThb)}
          </>
        )}
      </button>

      <p className="text-center text-xs leading-relaxed text-white/35">
        ชำระผ่าน PromptPay QR เท่านั้น · Stars ที่ซื้อแล้วไม่สามารถขอคืนเงินได้
        แต่สามารถขาย buyback ได้ที่ {formatThbRate(BUYBACK_THB_PER_STAR)} ต่อ Star
      </p>
    </form>
  );
}

/**
 * Matches the real form's block rhythm — tiles, panel, button — so the
 * screen does not reflow when pricing and balance resolve.
 */
function BuyStarsSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-6" aria-busy="true" aria-label="กำลังโหลด">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {STAR_PRESETS.map((preset) => (
          <div key={preset.stars} className="h-[5.5rem] rounded-2xl bg-white/[0.05]" />
        ))}
      </div>
      <div className="h-44 rounded-2xl bg-white/[0.05]" />
      <div className="h-28 rounded-2xl bg-white/[0.05]" />
      <div className="h-[3.25rem] rounded-2xl bg-white/[0.07]" />
    </div>
  );
}
