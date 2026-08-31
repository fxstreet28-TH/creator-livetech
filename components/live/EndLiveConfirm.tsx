'use client';

/**
 * "ยืนยันจบไลฟ์?" and, once the session is closed, its summary.
 *
 * One dialog with two faces rather than two components: the summary is the
 * answer to the button that was just pressed, and a modal that closes and
 * reopens somewhere else loses that thread. Once the summary is showing there
 * is no cancel — the session is ended on the server and cannot be reopened.
 *
 * Same focus-trap, Escape handling and scroll lock as DeletePostConfirm, which
 * is the pattern this repo already uses for a destructive confirmation.
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Loader2, PartyPopper } from 'lucide-react';
import { formatCount, formatDuration } from '@/lib/creator/format';
import { formatThbWithUnit } from '@/lib/wallet/format';
import type { EndLiveResponse } from '@/lib/live/types';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface EndLiveConfirmProps {
  /** Set once live-end-session has answered; switches the dialog to summary. */
  summary: EndLiveResponse | null;
  ending: boolean;
  /** Thai, renderable. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** "กลับสู่แดชบอร์ด" — only reachable from the summary. */
  onDone: () => void;
}

export function EndLiveConfirm({
  summary,
  ending,
  error,
  onConfirm,
  onCancel,
  onDone,
}: EndLiveConfirmProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  // Escape cancels only while the session is still open. Once the summary is
  // up there is nothing to cancel, and dismissing it would leave the creator
  // on a broadcasting screen for a broadcast that has ended.
  const dismissable = summary === null && !ending;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (dismissable) onCancel();
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
  }, [onCancel, dismissable]);

  // Focus lands on "ยกเลิก" while the session is live, and on the only button
  // there is once it has ended.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [summary]);

  const handleOverlayClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && dismissable) onCancel();
    },
    [onCancel, dismissable],
  );

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={handleOverlayClick}
      role="presentation"
    >
      <motion.div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, y: reduceMotion ? 0 : 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className={`my-auto w-full max-w-[26rem] rounded-2xl border p-6 shadow-[0_30px_90px_rgba(0,0,0,0.6)] ${
          summary ? 'border-purple-400/20 bg-[#120f1e]' : 'border-rose-400/20 bg-[#160f18]'
        }`}
      >
        {summary ? (
          <Summary titleId={titleId} summary={summary} onDone={onDone} />
        ) : (
          <Confirm
            titleId={titleId}
            ending={ending}
            error={error}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        )}
      </motion.div>
    </motion.div>
  );
}

function Confirm({
  titleId,
  ending,
  error,
  onConfirm,
  onCancel,
}: {
  titleId: string;
  ending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-500/15 text-rose-300">
          <AlertTriangle size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-bold text-white">
            ยืนยันจบไลฟ์?
          </h2>
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-white/65">
        ผู้ชมทุกคนจะออกจากห้องทันที และไลฟ์นี้จะเปิดใหม่ไม่ได้ — ครั้งหน้าต้องเริ่มไลฟ์ใหม่
      </p>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm leading-relaxed text-rose-100"
        >
          {error}
        </p>
      )}

      <div className="mt-5 flex flex-col gap-3 sm:flex-row-reverse">
        <button
          type="button"
          onClick={onConfirm}
          disabled={ending}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-rose-500 to-pink-500 px-4 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-rose-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-60"
        >
          {ending && <Loader2 size={15} className="animate-spin" aria-hidden />}
          จบไลฟ์
        </button>
        <button
          type="button"
          data-autofocus
          onClick={onCancel}
          disabled={ending}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
        >
          ยกเลิก
        </button>
      </div>
    </>
  );
}

/**
 * What live-end-session answered.
 *
 * `estimated_cost_thb` is the platform's LiveKit bill for this session, not
 * anything the creator is charged — it is labelled as such, because a number
 * in baht on a creator's screen otherwise reads as money they owe.
 *
 * `already_ended: true` comes back when the session was closed twice (a double
 * click, or a retry after a timeout that had actually succeeded). Every other
 * field is absent then, so the summary says so rather than reporting a
 * broadcast of zero seconds with no viewers.
 */
function Summary({
  titleId,
  summary,
  onDone,
}: {
  titleId: string;
  summary: EndLiveResponse;
  onDone: () => void;
}) {
  const alreadyEnded = summary.already_ended === true;

  return (
    <>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-purple-500/15 text-purple-200">
          <PartyPopper size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-bold text-white">
            จบไลฟ์แล้ว
          </h2>
          <p className="mt-1 text-sm text-white/55">
            {alreadyEnded ? 'ไลฟ์นี้ถูกปิดไปก่อนหน้านี้แล้ว' : 'ขอบคุณสำหรับการถ่ายทอดสด'}
          </p>
        </div>
      </div>

      {!alreadyEnded && (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-3">
            <SummaryStat label="ระยะเวลา" value={formatDuration(summary.duration_seconds)} />
            <SummaryStat label="ผู้ชมสูงสุด" value={`${formatCount(summary.peak_viewers)} คน`} />
            <SummaryStat label="ข้อความแชท" value={formatCount(summary.chat_messages)} />
            <SummaryStat label="ดาวที่ได้รับ" value={formatCount(summary.tips_received_stars)} />
          </dl>

          <p className="mt-3 text-center text-[11px] leading-relaxed text-white/35">
            ต้นทุนระบบโดยประมาณ {formatThbWithUnit(summary.estimated_cost_thb)} (ค่าใช้จ่ายของแพลตฟอร์ม ไม่ได้เรียกเก็บจากคุณ)
          </p>

          <p className="mt-2 text-center text-[11px] leading-relaxed text-white/35">
            {/* Recording is post-launch: LiveKit egress is not wired, so the
                video of this broadcast does not exist anywhere. Saying so
                beats letting a creator hunt for it. */}
            ไม่มีการบันทึกไลฟ์นี้ — ระบบบันทึกจะเปิดใช้งานภายหลัง
          </p>
        </>
      )}

      <button
        type="button"
        data-autofocus
        onClick={onDone}
        className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-cyan-400 px-4 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        กลับสู่แดชบอร์ด
      </button>
    </>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
      <dt className="text-[11px] text-white/45">{label}</dt>
      <dd className="mt-1 text-lg font-bold tabular-nums text-white">{value}</dd>
    </div>
  );
}
