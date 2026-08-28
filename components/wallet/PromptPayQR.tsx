'use client';

/**
 * The PromptPay QR the buyer scans in their bank app.
 *
 * The image is Stripe's own hosted PNG, rendered straight from
 * `next_action.promptpay_display_qr_code.image_url_png`. The same object also
 * carries a `data` string — the raw EMVCo payload — and it is deliberately
 * not used: re-encoding it here would mean shipping a QR library and owning
 * the correctness of a payment barcode, and a subtly wrong render is money
 * sent to nobody. Stripe's PNG is already the encoded, validated artifact.
 *
 * The countdown is a real deadline, not decoration. A PromptPay QR expires
 * about ten minutes after it is created; scanning an expired one fails in the
 * bank app with an error that says nothing about this screen, so the timer
 * has to be visible and the expiry has to be handled here.
 */

import { useEffect, useState } from 'react';
import { Browser } from '@capacitor/browser';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { isNative } from '@/lib/config';
import { formatCountdown, formatStars, formatThbWithUnit } from '@/lib/wallet/format';

interface PromptPayQRProps {
  imageUrlPng: string;
  hostedInstructionsUrl: string | null;
  stars: number;
  amountThb: number;
  /** Epoch milliseconds. Ten minutes out unless Stripe said otherwise. */
  expiresAt: number;
  /** Fired once, when the countdown reaches zero. */
  onExpired: () => void;
  /** True once the 60s realtime grace period has lapsed without an event. */
  waitingForConfirmation: boolean;
  /** Manual "I have paid" re-check, shown alongside the waiting notice. */
  onManualRefresh: () => void;
  refreshing: boolean;
}

function secondsUntil(timestamp: number): number {
  return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}

export function PromptPayQR({
  imageUrlPng,
  hostedInstructionsUrl,
  stars,
  amountThb,
  expiresAt,
  onExpired,
  waitingForConfirmation,
  onManualRefresh,
  refreshing,
}: PromptPayQRProps) {
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntil(expiresAt));
  const [copied, setCopied] = useState(false);

  // A new QR means a new deadline, and the reading has to change in the same
  // paint — a stale "9:58" under a freshly issued QR is a wrong number, not a
  // late one. Adjusted during render for that reason (and because doing it in
  // the effect below is a cascading-render lint error).
  const [imageFailed, setImageFailed] = useState(false);
  const [deadline, setDeadline] = useState(expiresAt);
  if (deadline !== expiresAt) {
    setDeadline(expiresAt);
    setSecondsLeft(secondsUntil(expiresAt));
  }

  useEffect(() => {
    // Recomputed from the deadline on every tick rather than decremented.
    // A decrementing counter drifts whenever the tab is backgrounded — which
    // is exactly what happens here, because the buyer leaves to their bank
    // app — and would show time remaining on a QR that already expired.
    const timer = window.setInterval(() => {
      const remaining = secondsUntil(expiresAt);
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        window.clearInterval(timer);
        onExpired();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [expiresAt, onExpired]);

  useEffect(() => {
    if (!copied) return;
    const reset = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(reset);
  }, [copied]);

  async function handleCopy() {
    if (!hostedInstructionsUrl) return;
    try {
      await navigator.clipboard.writeText(hostedInstructionsUrl);
      setCopied(true);
    } catch {
      // navigator.clipboard is undefined outside a secure context and can be
      // blocked by permissions policy. Falling back to a hidden textarea and
      // execCommand keeps the button working on the Android WebView, where
      // the modern API is the one more likely to be missing.
      try {
        const scratch = document.createElement('textarea');
        scratch.value = hostedInstructionsUrl;
        scratch.setAttribute('readonly', '');
        scratch.style.position = 'fixed';
        scratch.style.opacity = '0';
        document.body.appendChild(scratch);
        scratch.select();
        document.execCommand('copy');
        document.body.removeChild(scratch);
        setCopied(true);
      } catch {
        console.warn('[PromptPayQR] clipboard unavailable');
      }
    }
  }

  async function handleOpenInBankApp() {
    if (!hostedInstructionsUrl) return;
    if (isNative()) {
      // window.open inside the Capacitor WebView either does nothing or
      // navigates the shell away from the app. Browser.open hands the URL to
      // the system in-app browser, which is what can then hand off to a bank
      // app via its own URL scheme.
      await Browser.open({ url: hostedInstructionsUrl });
      return;
    }
    window.open(hostedInstructionsUrl, '_blank', 'noopener,noreferrer');
  }

  const expired = secondsLeft <= 0;

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="text-center">
        <p className="text-sm text-white/60">สแกน QR เพื่อชำระเงิน</p>
        <p className="mt-1 text-3xl font-bold text-white">{formatThbWithUnit(amountThb)}</p>
        <p className="mt-1 text-sm text-white/50">สำหรับ {formatStars(stars)} Stars</p>
      </div>

      {/* If Stripe's PNG does not load, the white panel would otherwise sit
          there empty — a dead end in the middle of a payment, with no hint
          that anything is wrong. The hosted payment page is the same
          transaction and is still reachable from the buttons below, so the
          fallback says so rather than leaving a blank square. */}
      {imageFailed ? (
        <div
          role="alert"
          className="flex h-68 w-full max-w-[17rem] flex-col items-center justify-center gap-3 rounded-3xl border border-amber-400/30 bg-amber-400/10 p-6 text-center"
        >
          <p className="text-sm text-amber-100">ไม่สามารถโหลดรูป QR ได้</p>
          <p className="text-xs leading-relaxed text-amber-100/70">
            {hostedInstructionsUrl
              ? 'กรุณาใช้ปุ่ม "เปิดในแอปธนาคาร" ด้านล่างเพื่อชำระเงิน'
              : 'กรุณายกเลิกและสร้างรายการใหม่อีกครั้ง'}
          </p>
        </div>
      ) : (
        <div className="rounded-3xl bg-white p-4 shadow-xl shadow-purple-900/20">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrlPng}
            alt={`PromptPay QR code สำหรับชำระเงิน ${formatThbWithUnit(amountThb)}`}
            width={240}
            height={240}
            onError={() => setImageFailed(true)}
            className={`h-60 w-60 transition ${expired ? 'opacity-25 grayscale' : ''}`}
          />
        </div>
      )}

      <p
        className={`text-sm font-medium tabular-nums ${
          expired ? 'text-red-300' : secondsLeft <= 60 ? 'text-amber-300' : 'text-white/60'
        }`}
        role="status"
        // Announcing every second would make a screen reader unusable. The
        // countdown is polite-live only in its last minute, when it is
        // actually news; before that the visible timer carries it.
        aria-live={secondsLeft <= 60 ? 'polite' : 'off'}
      >
        {expired ? 'QR หมดอายุแล้ว' : `QR หมดอายุใน ${formatCountdown(secondsLeft)} นาที`}
      </p>

      {hostedInstructionsUrl && (
        <div className="flex w-full flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={handleCopy}
            disabled={expired}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-40"
          >
            {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
            {copied ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์'}
          </button>

          <button
            type="button"
            onClick={handleOpenInBankApp}
            disabled={expired}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-purple-400/40 bg-purple-500/15 px-4 py-3 text-sm font-semibold text-purple-100 transition hover:bg-purple-500/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-40"
          >
            <ExternalLink size={16} aria-hidden />
            เปิดในแอปธนาคาร
          </button>
        </div>
      )}

      {waitingForConfirmation && !expired && (
        <div className="w-full rounded-xl border border-amber-400/25 bg-amber-400/10 p-4 text-center">
          <p className="text-sm text-amber-100" role="status">
            รอสักครู่ กำลังยืนยันการชำระเงิน...
          </p>
          <button
            type="button"
            onClick={onManualRefresh}
            disabled={refreshing}
            className="mt-3 min-h-11 rounded-xl border border-amber-300/40 px-5 py-2.5 text-sm font-semibold text-amber-100 transition hover:bg-amber-400/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
          >
            {refreshing ? 'กำลังตรวจสอบ...' : 'รีเฟรช'}
          </button>
        </div>
      )}

      <p className="max-w-sm text-center text-xs leading-relaxed text-white/40">
        เปิดแอปธนาคารของคุณ เลือกสแกน QR แล้วชำระเงินตามจำนวนที่แสดง
        Stars จะเข้ากระเป๋าอัตโนมัติหลังชำระเงินสำเร็จ
      </p>
    </div>
  );
}
