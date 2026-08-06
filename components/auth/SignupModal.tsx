'use client';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Step1Credentials } from './steps/Step1Credentials';
import { Step2Verify } from './steps/Step2Verify';
import { Step3Success } from './steps/Step3Success';

type Step = 1 | 2 | 3;

interface SignupModalProps {
  open: boolean;
  onClose: () => void;
}

export interface SignupState {
  phone: string;
  email: string;
  password: string;
  sessionId: string | null;
  phoneMasked: string;
  emailMasked: string;
  smsSent: boolean;
  emailSent: boolean;
}

const EMPTY_STATE: SignupState = {
  phone: '',
  email: '',
  password: '',
  sessionId: null,
  phoneMasked: '',
  emailMasked: '',
  smsSent: true,
  emailSent: true,
};

export function SignupModal({ open, onClose }: SignupModalProps) {
  // ModalContent only mounts while open, so its step/state reset naturally on
  // each open — no setState-in-effect needed.
  return (
    <AnimatePresence>{open && <ModalContent onClose={onClose} />}</AnimatePresence>
  );
}

function ModalContent({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>(1);
  const [state, setState] = useState<SignupState>(EMPTY_STATE);

  // Lock body scroll while the modal is mounted.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Close on Escape (except on the success step, which auto-advances).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step !== 3) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && step !== 3) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="relative w-full max-w-md bg-[#14142b]/95 border border-white/10 rounded-2xl shadow-2xl shadow-purple-500/20 p-6 md:p-8 max-h-[92vh] overflow-y-auto"
      >
        {step !== 3 && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-white/40 hover:text-white transition"
            aria-label="ปิด"
          >
            ✕
          </button>
        )}

        <AnimatePresence mode="wait">
          {step === 1 && (
            <motion.div
              key="s1"
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <Step1Credentials state={state} setState={setState} onNext={() => setStep(2)} />
            </motion.div>
          )}
          {step === 2 && (
            <motion.div
              key="s2"
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <Step2Verify state={state} onBack={() => setStep(1)} onNext={() => setStep(3)} />
            </motion.div>
          )}
          {step === 3 && (
            <motion.div
              key="s3"
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <Step3Success onClose={onClose} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
