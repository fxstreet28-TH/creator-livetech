'use client';

/**
 * Confirm and perform a post deletion.
 *
 * `delete` on feed_posts, nothing more. There is no trigger on the table that
 * queues the Bunny video for removal — checked, and there is none — so the
 * Bunny asset is left to the backend's orphan cleanup. Calling Bunny's delete
 * API from the browser is not an option worth wanting: it would need the
 * library API key in the page.
 *
 * The copy says 24 hours because that is what the creator is promised; the
 * row itself disappears immediately.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DeletePostConfirmProps {
  postId: string;
  postTitle: string | null;
  onClose: () => void;
  /** Called once the row is gone; the page redirects from here. */
  onDeleted: () => void;
}

export function DeletePostConfirm({
  postId,
  postTitle,
  onClose,
  onDeleted,
}: DeletePostConfirmProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Focus lands on the cancel button, not on "ลบโพสต์": the destructive
  // control should never be one Enter away from a dialog that just opened.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);

  const handleOverlayClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !deleting) onClose();
    },
    [onClose, deleting],
  );

  async function handleDelete() {
    if (deleting) return;
    setError(null);
    setDeleting(true);

    let supabase;
    try {
      supabase = getBrowserSupabase();
    } catch {
      setError('ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง');
      setDeleting(false);
      return;
    }

    const { error: deleteError } = await supabase.from('feed_posts').delete().eq('id', postId);

    if (deleteError) {
      console.error('[DeletePostConfirm] feed_posts delete failed', deleteError);
      setError('ลบโพสต์ไม่สำเร็จ กรุณาลองใหม่');
      setDeleting(false);
      return;
    }

    // Deliberately not clearing `deleting`: the page navigates away next, and
    // re-enabling the button first would allow a second delete on the way out.
    onDeleted();
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/65 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]"
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
        className="my-auto w-full max-w-[26rem] rounded-2xl border border-rose-400/20 bg-[#160f18] p-6 shadow-[0_30px_90px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-500/15 text-rose-300">
            <AlertTriangle size={20} aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-bold text-white">
              ลบโพสต์นี้?
            </h2>
            {postTitle && (
              <p className="mt-1 line-clamp-2 break-all text-sm text-white/60">{postTitle}</p>
            )}
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-white/65">
          การลบไม่สามารถย้อนกลับได้ วิดีโอจะถูกลบจากระบบภายใน 24 ชั่วโมง
        </p>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-col gap-3 sm:flex-row-reverse">
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-rose-500 px-4 py-3 text-sm font-bold text-white transition hover:bg-rose-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-60"
          >
            {deleting && <Loader2 size={15} className="animate-spin" aria-hidden />}
            ลบโพสต์
          </button>
          <button
            type="button"
            data-autofocus
            onClick={onClose}
            disabled={deleting}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
          >
            ยกเลิก
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
