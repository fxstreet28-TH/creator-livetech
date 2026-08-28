'use client';

/**
 * Sell stars back for THB at the fixed 3.00 THB/star rate.
 *
 * The one-way door in the Star economy, and the form is written to read that
 * way. A buyer paid 11.00 THB per star and gets 3.00 back; that gap is the
 * stated policy (there is no refund path — PromptPay is a push payment and
 * cannot be reversed), so the rate is presented as a fact, never as an offer,
 * and the summary shows the payout before the submit button rather than
 * after it.
 *
 * The stars leave the wallet the moment request_buyback commits. The THB is
 * transferred by hand, by an admin, days later — which is why the
 * confirmation leads with the 3-5 business day window instead of implying
 * anything has already been paid.
 */

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { invokeEdge, isRetryable, type EdgeError } from '@/lib/wallet/invoke';
import { useWalletSummary } from '@/lib/hooks/useWalletSummary';
import { BUYBACK_THB_PER_STAR, MIN_BUYBACK_STARS } from '@/lib/constants/stars';
import { MAX_ACCOUNT_DIGITS, MIN_ACCOUNT_DIGITS } from '@/lib/constants/thaiBanks';
import { formatStars, formatThbRate, formatThbWithUnit } from '@/lib/wallet/format';
import { BankAccountFields, type BankDetails, type BankFieldErrors } from './BankAccountFields';

interface BuybackResponse {
  success: boolean;
  request_id: string;
  star_amount: number;
  total_thb: number;
  thb_per_star: number;
  status: string;
  new_wallet_balance: number;
  message: string;
}

const EMPTY_BANK: BankDetails = { bankCode: '', accountNumber: '', accountName: '' };

export function BuybackForm() {
  const wallet = useWalletSummary();

  const [starsText, setStarsText] = useState('');
  const [bank, setBank] = useState<BankDetails>(EMPTY_BANK);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<EdgeError | null>(null);
  const [result, setResult] = useState<BuybackResponse | null>(null);
  /** Errors are only rendered once the user has tried to submit. */
  const [showErrors, setShowErrors] = useState(false);

  const stars = starsText === '' ? 0 : Number(starsText);
  const payoutThb = stars * BUYBACK_THB_PER_STAR;

  /**
   * Client-side mirror of buyback-request's validation. Wording is copied
   * from _shared/errors.ts so the message does not change depending on which
   * side caught it.
   */
  function starsError(): string | null {
    if (starsText === '' || !Number.isInteger(stars) || stars <= 0) return 'กรุณากรอกจำนวน Stars';
    if (stars < MIN_BUYBACK_STARS) {
      return `ต้องขาย buyback อย่างน้อย ${formatStars(MIN_BUYBACK_STARS)} stars`;
    }
    if (stars > wallet.balance) return 'จำนวน stars ไม่พอ';
    return null;
  }

  function bankErrors(): BankFieldErrors {
    const errors: BankFieldErrors = {};
    if (bank.bankCode === '') errors.bankCode = 'กรุณากรอกข้อมูลธนาคารให้ครบ';
    if (bank.accountName.trim() === '') errors.accountName = 'กรุณากรอกข้อมูลธนาคารให้ครบ';

    const digits = bank.accountNumber.replace(/\D/g, '');
    if (digits === '') {
      errors.accountNumber = 'กรุณากรอกข้อมูลธนาคารให้ครบ';
    } else if (digits.length < MIN_ACCOUNT_DIGITS || digits.length > MAX_ACCOUNT_DIGITS) {
      errors.accountNumber = 'เลขที่บัญชีธนาคารไม่ถูกต้อง';
    }
    return errors;
  }

  const amountError = starsError();
  const fieldErrors = bankErrors();
  const formValid = amountError === null && Object.keys(fieldErrors).length === 0;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setShowErrors(true);
    if (!formValid) return;

    setError(null);
    setSubmitting(true);

    const supabase = getBrowserSupabase();
    const { data, error: submitError } = await invokeEdge<BuybackResponse>(
      supabase,
      'buyback-request',
      {
        body: {
          star_amount: stars,
          // The short code, not the display name: this lands in
          // buyback_requests.bank_name and an admin reads it to make the
          // transfer, so it has to be one consistent token per bank.
          bank_name: bank.bankCode,
          bank_account_number: bank.accountNumber,
          bank_account_name: bank.accountName.trim(),
        },
      },
    );

    setSubmitting(false);

    if (submitError || !data) {
      // No automatic retry in either direction. A 4xx is the user's input or
      // their balance and would fail identically; a 5xx is offered as a
      // button below, because request_buyback is not idempotent and a
      // silent retry could deduct twice if the first call actually committed.
      setError(submitError ?? { code: 'internal_error', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
      return;
    }

    setResult(data);
  }

  if (wallet.loading) return <BuybackSkeleton />;

  if (result) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-8 text-center">
        <CheckCircle2 size={56} className="text-emerald-300" aria-hidden />
        <h2 className="text-xl font-bold text-white" role="status">
          คำขอ buyback ถูกสร้างเรียบร้อยแล้ว
        </h2>
        <p className="text-sm text-white/70">จะได้รับเงินภายใน 3-5 วันทำการ</p>

        <dl className="mt-2 w-full space-y-2 rounded-xl border border-white/8 bg-white/[0.03] p-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-white/55">จำนวนที่ขาย</dt>
            <dd className="font-medium text-white">{formatStars(result.star_amount)} Stars</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-white/55">ยอดที่จะได้รับ</dt>
            <dd className="font-medium text-white">{formatThbWithUnit(Number(result.total_thb))}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-white/55">ยอดคงเหลือ</dt>
            <dd className="font-medium text-white">
              {formatStars(Number(result.new_wallet_balance))} Stars
            </dd>
          </div>
        </dl>

        <p className="text-[11px] text-white/35">
          รหัสอ้างอิง: <span className="font-mono">{result.request_id}</span>
        </p>

        <div className="mt-2 flex w-full flex-col gap-3 sm:flex-row">
          <Link
            href="/wallet"
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            กลับไปที่ Wallet
          </Link>
          <Link
            href="/wallet?tab=buyback"
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            ดูประวัติ buyback
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100"
        >
          <p>{error.message}</p>
          {isRetryable(error) && (
            <button
              type="button"
              onClick={() => setError(null)}
              className="mt-3 min-h-11 rounded-xl border border-red-300/40 px-4 py-2 text-sm font-semibold text-red-100 transition hover:bg-red-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              ลองใหม่อีกครั้ง
            </button>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-white/60">ยอดคงเหลือ</span>
          <span className="text-lg font-bold text-white">
            {formatStars(wallet.balance)} Stars
          </span>
        </div>
      </div>

      <div>
        <label htmlFor="buyback-stars" className="mb-2 block text-sm font-medium text-white/70">
          จำนวน Stars ที่ต้องการขาย
        </label>
        <div className="flex items-center gap-3">
          <input
            id="buyback-stars"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={starsText}
            disabled={submitting}
            onChange={(event) => {
              setStarsText(event.target.value.replace(/\D/g, ''));
              setError(null);
            }}
            aria-invalid={showErrors && amountError ? true : undefined}
            aria-describedby={showErrors && amountError ? 'buyback-stars-error' : undefined}
            className={`min-h-11 w-full rounded-xl border bg-[#0a0a12] px-4 py-3 text-base text-white transition placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50 ${
              showErrors && amountError
                ? 'border-red-500/60'
                : 'border-white/10 focus:border-purple-400'
            }`}
            placeholder={String(MIN_BUYBACK_STARS)}
          />
          <span className="shrink-0 text-sm text-white/50">Stars</span>
        </div>
        {showErrors && amountError && (
          <p id="buyback-stars-error" role="alert" className="mt-2 text-sm text-red-300">
            {amountError}
          </p>
        )}
      </div>

      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-white/60">อัตรารับซื้อคืน</span>
          <span className="font-medium text-white">
            {formatThbRate(BUYBACK_THB_PER_STAR)} ต่อ Star
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-white/8 pt-3">
          <span className="text-sm text-white/60">ยอดที่จะได้รับ</span>
          <span
            className="text-xl font-bold text-white"
            // The payout updates as the amount is typed; announcing it
            // politely means a screen reader user hears the number they are
            // agreeing to without having to hunt for it.
            aria-live="polite"
          >
            {formatThbWithUnit(payoutThb)}
          </span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-white/40">
          อัตรารับซื้อคืนคงที่ที่ {formatThbRate(BUYBACK_THB_PER_STAR)} ต่อ Star
          และไม่สามารถต่อรองได้ Stars จะถูกหักออกจากกระเป๋าทันทีเมื่อส่งคำขอ
        </p>
      </div>

      <BankAccountFields
        value={bank}
        onChange={(next) => {
          setBank(next);
          setError(null);
        }}
        errors={showErrors ? fieldErrors : {}}
        disabled={submitting}
      />

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex min-h-[3.25rem] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-purple-500 to-pink-500 px-6 py-4 text-base font-extrabold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:shadow-none"
      >
        {submitting ? (
          <>
            <Loader2 size={18} className="animate-spin" aria-hidden />
            กำลังส่งคำขอ...
          </>
        ) : (
          <>ขาย {formatStars(stars)} Stars — รับ {formatThbWithUnit(payoutThb)}</>
        )}
      </button>

      <p className="text-center text-xs leading-relaxed text-white/35">
        การโอนเงินดำเนินการโดยทีมงาน จะได้รับเงินภายใน 3-5 วันทำการ
        กรุณาตรวจสอบชื่อบัญชีให้ตรงกับบัตรประชาชน
      </p>
    </form>
  );
}

function BuybackSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-6" aria-busy="true" aria-label="กำลังโหลด">
      <div className="h-16 rounded-2xl bg-white/[0.05]" />
      <div className="h-20 rounded-2xl bg-white/[0.05]" />
      <div className="h-32 rounded-2xl bg-white/[0.05]" />
      <div className="h-64 rounded-2xl bg-white/[0.05]" />
      <div className="h-[3.25rem] rounded-2xl bg-white/[0.07]" />
    </div>
  );
}
