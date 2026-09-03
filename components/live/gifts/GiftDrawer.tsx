'use client';

/**
 * The send-a-gift sheet: a bottom sheet on a phone, a right-hand popover on a
 * desktop, the same component either way.
 *
 * PRICES COME FROM THE DATABASE, ALWAYS.
 *
 * Every number on this screen is read from `gift_tiers`. Nothing here knows
 * what a Stardust costs, and it must not: the CEO sets final pricing with an
 * UPDATE, `send_live_gift` prices the spend from the same row, and a constant
 * in this file would be the one place the display and the charge could
 * disagree. That is also why the total is `price_stars × quantity` computed
 * from the fetched row rather than sent to the server — the request carries a
 * tier and a count, never an amount.
 *
 * NOTHING IS RENDERED OPTIMISTICALLY.
 *
 * A 200 closes the sheet and updates the balance. The ANIMATION comes from the
 * broadcast the INSERT produced, like everyone else's — so the sender sees the
 * same gift, at the same moment, as the creator and every other viewer. An
 * optimistic overlay would make the sender's screen the one screen that can
 * disagree with the room, and it would still be wrong in the case that matters:
 * a send that appeared to work and did not.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, X } from 'lucide-react';
import {
  GIFT_QUANTITY_PRESETS,
  MAX_GIFT_MESSAGE_LENGTH,
  rarityStyle,
  sendLiveGift,
  type GiftError,
  type GiftTier,
} from '@/lib/live/gifts';
import { getBrowserSupabase } from '@/lib/supabase-browser';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface GiftDrawerProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  tiers: GiftTier[];
  /** Null while wallet-get is in flight; the sheet stays usable. */
  balance: number | null;
  /** Thai, renderable — the tier read failed. */
  tiersError: string | null;
  /** Called with the balance the send returned, so the caller can repaint. */
  onSent: (walletBalance: number) => void;
}

/**
 * The gate.
 *
 * The sheet's own state — which tier, how many, the message, the last refusal —
 * lives in a child that only exists while the drawer is open. That is what
 * makes closing it a reset, with no effect watching `open` to clear four
 * useStates: an effect that calls setState synchronously is a cascading render,
 * and unmounting is the cheaper and more obviously correct way to forget
 * something.
 */
export function GiftDrawer(props: GiftDrawerProps) {
  if (!props.open) return null;
  return <GiftSheet {...props} />;
}

function GiftSheet({
  onClose,
  sessionId,
  tiers,
  balance,
  tiersError,
  onSent,
}: GiftDrawerProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<GiftError | null>(null);

  const selected = useMemo(
    () => tiers.find((tier) => tier.id === selectedId) ?? null,
    [tiers, selectedId],
  );

  const total = selected ? selected.price_stars * quantity : 0;

  /**
   * Insufficient only when the balance is KNOWN.
   *
   * A null balance means wallet-get has not answered, and treating that as
   * "not enough" would show a top-up button to somebody with a full wallet.
   * The server refuses an actual shortfall anyway, so being optimistic here is
   * the safe direction.
   */
  const insufficient = balance !== null && selected !== null && total > balance;

  const topUpHref = `/wallet/buy-stars?redirect=${encodeURIComponent(`/live/${sessionId}`)}`;

  // Escape, focus trap and scroll lock — the same pattern EndLiveConfirm and
  // DeletePostConfirm use, because this is the third modal in the repo and a
  // third behaviour would be the one users notice.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const card = cardRef.current;
      if (!card) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !card.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const selectTier = useCallback((tier: GiftTier) => {
    setSelectedId(tier.id);
    setError(null);
    // Clamped rather than reset: someone who picked ×10 and then switched tier
    // meant ×10, unless the new tier does not allow it.
    setQuantity((current) => Math.min(Math.max(1, current), tier.max_quantity));
  }, []);

  const submit = async () => {
    if (!selected || sending || insufficient) return;

    setSending(true);
    setError(null);

    let supabase;
    try {
      supabase = getBrowserSupabase();
    } catch {
      setError({ code: 'not_configured', message: 'ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง' });
      setSending(false);
      return;
    }

    const { data, error: sendError } = await sendLiveGift(supabase, {
      session_id: sessionId,
      tier_id: selected.id,
      quantity,
      ...(message.trim() !== '' ? { message: message.trim() } : {}),
    });

    if (sendError || !data) {
      setError(sendError ?? { code: 'internal_error', message: 'ส่งของขวัญไม่สำเร็จ กรุณาลองใหม่' });
      setSending(false);
      return;
    }

    onSent(data.wallet_balance);
    setSending(false);
    onClose();
  };

  const maxQuantity = selected?.max_quantity ?? 99;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[88dvh] w-full overflow-y-auto rounded-t-3xl border-t border-white/12 bg-[#120f1e] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-md sm:rounded-3xl sm:border"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/8 bg-[#120f1e] px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-bold text-white">
              ส่งของขวัญ
            </h2>
            <p className="mt-0.5 text-xs tabular-nums text-white/50">
              {balance === null ? 'กำลังโหลดยอดดาว...' : `⭐ ${balance.toLocaleString('th-TH')}`}
              {' · '}
              <Link href={topUpHref} className="text-cyan-300 underline-offset-2 hover:underline">
                เติมดาว
              </Link>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white/50 transition hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="px-4 pt-4">
          {tiersError ? (
            <p role="alert" className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
              {tiersError}
            </p>
          ) : tiers.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-white/40">
              ยังไม่มีของขวัญให้ส่ง
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {tiers.map((tier) => {
                const rarity = rarityStyle(tier.rarity);
                const active = tier.id === selectedId;
                return (
                  <li key={tier.id}>
                    <button
                      type="button"
                      onClick={() => selectTier(tier)}
                      aria-pressed={active}
                      className={`flex min-h-11 w-full flex-col items-center gap-1 rounded-2xl border p-2 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${rarity.surface} ${
                        active ? 'ring-2 ring-cyan-400' : 'hover:brightness-125'
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/gifts/tier-${String(tier.id).padStart(2, '0')}/body.png`}
                        alt=""
                        width={56}
                        height={56}
                        loading="lazy"
                        className="h-14 w-14 object-contain"
                      />
                      <span className={`text-xs font-bold leading-tight ${rarity.text}`}>
                        {tier.name_en}
                      </span>
                      <span className="text-[10px] leading-tight text-white/50">{tier.name_th}</span>
                      <span className="text-[11px] font-semibold tabular-nums text-amber-200">
                        ⭐ {tier.price_stars.toLocaleString('th-TH')}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selected && (
          <div className="mt-4 space-y-3 border-t border-white/8 px-4 pt-4">
            {selected.subtitle_th && (
              <p className="text-xs italic text-white/45">“{selected.subtitle_th}”</p>
            )}

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
                จำนวน
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {GIFT_QUANTITY_PRESETS.filter((value) => value <= maxQuantity).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setQuantity(value)}
                    aria-pressed={value === quantity}
                    className={`min-h-11 min-w-11 rounded-xl border px-3 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                      value === quantity
                        ? 'border-purple-400/60 bg-purple-500/20 text-purple-100'
                        : 'border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/[0.06]'
                    }`}
                  >
                    ×{value}
                  </button>
                ))}
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={maxQuantity}
                  value={quantity}
                  onChange={(event) => {
                    // Clamped on change, not on blur: an out-of-range value
                    // sitting in the box while the total and the button read
                    // from it would show a price the server will refuse.
                    const next = Number(event.target.value);
                    if (!Number.isFinite(next)) return;
                    setQuantity(Math.min(maxQuantity, Math.max(1, Math.floor(next))));
                  }}
                  aria-label={`จำนวน (สูงสุด ${maxQuantity})`}
                  className="h-11 w-20 rounded-xl border border-white/10 bg-black/30 px-3 text-sm tabular-nums text-white focus:border-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                />
              </div>
            </div>

            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
                ข้อความ (ไม่บังคับ)
              </span>
              <input
                type="text"
                value={message}
                maxLength={MAX_GIFT_MESSAGE_LENGTH}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="เขียนอะไรถึง Creator..."
                className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white placeholder:text-white/25 focus:border-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              />
              <span className="mt-1 block text-right text-[10px] tabular-nums text-white/25">
                {message.length}/{MAX_GIFT_MESSAGE_LENGTH}
              </span>
            </label>

            <p className="flex items-center justify-between text-sm">
              <span className="text-white/55">รวม</span>
              <span className="font-bold tabular-nums text-amber-200">
                {total.toLocaleString('th-TH')} ⭐
              </span>
            </p>

            {error && (
              <div
                role="alert"
                className="rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm leading-relaxed text-rose-100"
              >
                {error.message}
                {/* The RPC hands back the two numbers, so the shortfall can be
                    named instead of leaving the viewer to work it out. */}
                {error.code === 'INSUFFICIENT_STARS' &&
                  error.balance !== undefined &&
                  error.required !== undefined && (
                    <span className="mt-1 block text-xs text-rose-200/70">
                      มี {error.balance.toLocaleString('th-TH')} ⭐ · ต้องใช้{' '}
                      {error.required.toLocaleString('th-TH')} ⭐
                    </span>
                  )}
                {error.code === 'QUANTITY_TOO_HIGH' && error.maxQuantity !== undefined && (
                  <span className="mt-1 block text-xs text-rose-200/70">
                    สูงสุด {error.maxQuantity.toLocaleString('th-TH')} ชิ้นต่อครั้ง
                  </span>
                )}
              </div>
            )}

            {insufficient ? (
              // Never a negative number: the shortfall is expressed as an
              // action, not as a debt the viewer has to read off the screen.
              <Link
                href={topUpHref}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 px-4 py-3 text-sm font-bold text-black transition hover:shadow-lg hover:shadow-amber-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                ดาวไม่พอ · เติมดาว
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={sending}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-60"
              >
                {sending && <Loader2 size={15} className="animate-spin" aria-hidden />}
                ส่ง {selected.name_en} ×{quantity}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
