'use client';

/**
 * Dialog shell for the feedback form: overlay, focus trap, and the three ways
 * out (X, overlay click, Escape).
 *
 * Mounted only while open — the parent renders it conditionally — so closing
 * discards the draft rather than leaving a half-typed message and a stale
 * error behind for the next open. That is the same pattern
 * ForgotPasswordModal uses.
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { FeedbackForm } from './FeedbackForm';
import type { FeedbackSuccess } from '@/lib/hooks/useSubmitFeedback';

/** Everything focusable the trap should cycle through, in DOM order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FeedbackModalProps {
  onClose: () => void;
  onSubmitted: (result: FeedbackSuccess) => void;
}

export function FeedbackModal({ onClose, onSubmitted }: FeedbackModalProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  // framer-motion does not drop transforms on its own — its default
  // reducedMotion is 'never' — so the slide is opted out of by hand, the way
  // AnimatedLogo and PrismStar already do it. The fade stays: it carries the
  // open without moving anything.
  const reduceMotion = useReducedMotion();
  const slideIn = reduceMotion ? 0 : 12;
  const slideOut = reduceMotion ? 0 : 8;

  // Escape closes, and the page behind must not scroll while the modal is up.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Focus trap. Without it, Tab walks out of the dialog and into the page
      // behind, which for a screen-reader or keyboard user means the modal
      // silently stops being the thing they are operating.
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

  // Open with focus inside the dialog rather than back on the floating button,
  // so the first Tab lands on a form control.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, []);

  const handleOverlayClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Only a click that both started and ended on the scrim closes it — a
      // drag that begins inside the card and releases outside must not.
      if (event.target === event.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] pt-[calc(1rem+env(safe-area-inset-top))]"
      style={{ backgroundColor: 'rgba(26, 22, 20, 0.5)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={handleOverlayClick}
      role="presentation"
    >
      <motion.div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // Fade + slide up, the quiet version: 12px and 200ms.
        initial={{ opacity: 0, y: slideIn }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: slideOut }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="relative my-auto w-full max-w-[480px] rounded-2xl bg-white p-6 shadow-[0_24px_64px_rgba(26,22,20,0.28)] sm:p-8"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="ปิด"
          className="absolute right-2 top-2 grid h-11 w-11 place-items-center rounded-lg text-[#8A8579] transition-colors hover:bg-black/[0.04] hover:text-[#1A1614]"
        >
          <X size={18} aria-hidden />
        </button>

        <FeedbackForm titleId={titleId} onSubmitted={onSubmitted} onCancel={onClose} />
      </motion.div>
    </motion.div>
  );
}
