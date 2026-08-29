'use client';

/**
 * The confirmation shown after feedback is accepted.
 *
 * Success only, on purpose. A failure leaves the modal open — the user's text
 * is still in it — and on a 375px viewport that modal fills the screen, so a
 * fixed toast lands on top of the form it is complaining about. Failures are
 * therefore reported inside the modal, next to the field the user would
 * change, where they also persist instead of timing out. This toast exists for
 * the one message that has no modal left to live in.
 */

import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2 } from 'lucide-react';

/** Long enough to read one sentence, short enough not to linger. */
const VISIBLE_MS = 4000;

export interface FeedbackToastState {
  message: string;
  /** Bumped per toast so a repeat of the same message restarts the timer. */
  key: number;
}

interface FeedbackToastProps {
  toast: FeedbackToastState;
  onDismiss: () => void;
}

export function FeedbackToast({ toast, onDismiss }: FeedbackToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [toast.key, onDismiss]);

  return (
    <motion.div
      // Top-centre, below the dashboard TopBar, so it covers neither the bottom
      // nav nor the floating button that raised it. z-60 clears the modal layer.
      className="pointer-events-none fixed inset-x-0 top-[calc(4.5rem+env(safe-area-inset-top))] z-[60] flex justify-center px-4"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <div
        // Polite: the submit succeeded and the modal already closed, so there
        // is nothing the user must act on.
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-[min(28rem,100%)] items-start gap-2.5 rounded-xl px-4 py-3 text-[13px] leading-snug text-white shadow-[0_8px_24px_rgba(26,22,20,0.24)]"
        // Sage green, from the warm AURUM palette rather than the app's violet
        // chrome: the widget's surface is the one the notification emails use.
        style={{ backgroundColor: '#6B8E5A' }}
      >
        <CheckCircle2 size={17} className="mt-px shrink-0" aria-hidden />
        <span>{toast.message}</span>
      </div>
    </motion.div>
  );
}
