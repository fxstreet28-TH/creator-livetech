'use client';

/**
 * Floating "send feedback" button, its modal, and the toast that follows a
 * submit. Mounted once in the root layout, so it is present on every screen.
 *
 * Auth-gated by rendering nothing at all when there is no session. That is not
 * only cosmetic: send-feedback runs with verify_jwt, so the button would be a
 * guaranteed 401 for a signed-out visitor. useDashboardUser is the same hook
 * the dashboard chrome uses and it subscribes to onAuthStateChange, so a
 * sign-out while a page is open removes the button without a reload.
 *
 * Placement note: the mobile bottom nav is fixed at the bottom of the viewport
 * with a 4rem height plus the safe-area inset, so on small screens the button
 * is lifted clear of it rather than sitting on top of it. The lift is
 * unconditional: the nav is the only fixed bottom element in the app today,
 * and a button that sits 1rem higher on the marketing pages costs nothing next
 * to one that lands on top of the nav on every dashboard screen. It sits at z-30
 * — deliberately below the mobile drawer's z-40 scrim, so an open drawer
 * covers the button instead of the button floating over it.
 *
 * Failures are not toasted from here: the modal stays open on every one of
 * them and reports the reason inline, beside the message it refers to. This
 * component only raises the confirmation, which has no modal left to live in.
 */

import { useCallback, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { MessageCircle } from 'lucide-react';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';
import { FeedbackModal } from './FeedbackModal';
import { FeedbackToast, type FeedbackToastState } from './FeedbackToast';

export function FeedbackWidget() {
  const { user, loading } = useDashboardUser();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<FeedbackToastState | null>(null);
  const toastKey = useRef(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const raiseToast = useCallback((message: string) => {
    toastKey.current += 1;
    setToast({ message, key: toastKey.current });
  }, []);

  const closeModal = useCallback(() => {
    setOpen(false);
    // Send focus back where it came from. Without this it falls to <body> and
    // a keyboard user has to tab in from the top of the page again.
    buttonRef.current?.focus();
  }, []);

  const handleSubmitted = useCallback(
    () => {
      // The row is stored even when the notification email fails, so the user
      // is thanked on `success` regardless of the response's `email` field —
      // telling them the mail relay hiccuped would be reporting our problem as
      // theirs.
      closeModal();
      raiseToast('ขอบคุณ! ทางเราได้รับความคิดเห็นของคุณแล้ว');
    },
    [closeModal, raiseToast],
  );

  // Nothing renders until the session check settles, so the button never
  // flashes for a signed-out visitor on first paint.
  if (loading || !user) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="แชร์ความคิดเห็น"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="group fixed z-30 grid h-14 w-14 place-items-center rounded-full text-[#1A1614] transition-transform duration-200 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C9A961] md:h-16 md:w-16 right-[calc(1rem+env(safe-area-inset-right))] md:right-[calc(1.5rem+env(safe-area-inset-right))] bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-6"
        style={{
          background: 'linear-gradient(135deg, #C9A961 0%, #A47E1B 100%)',
          boxShadow: '0 4px 12px rgba(74,55,20,0.15), 0 2px 4px rgba(74,55,20,0.1)',
        }}
      >
        <MessageCircle size={24} strokeWidth={1.75} aria-hidden />

        {/* Tooltip. Pointer-only: on a touch screen there is no hover, and a
            label that can never be dismissed sits over the content. */}
        <span
          aria-hidden
          className="pointer-events-none absolute right-full mr-3 hidden whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] text-[#F5EEDA] opacity-0 transition-opacity duration-200 group-hover:opacity-100 md:block"
          style={{ backgroundColor: '#1A1614' }}
        >
          แชร์ความคิดเห็น
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <FeedbackModal onClose={closeModal} onSubmitted={handleSubmitted} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && <FeedbackToast toast={toast} onDismiss={() => setToast(null)} />}
      </AnimatePresence>
    </>
  );
}
