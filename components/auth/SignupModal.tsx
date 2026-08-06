'use client';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Step1Credentials } from './steps/Step1Credentials';
import { Step2Verify } from './steps/Step2Verify';
import { Step3Success } from './steps/Step3Success';
import { AnimatedLogo } from './AnimatedLogo';
import { StarField } from './StarField';
import { SignupStepper } from './SignupStepper';

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

const THAI_FONT = '"Noto Sans Thai", "Leelawadee UI", Arial, sans-serif';

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && step !== 3) onClose();
      }}
      role="dialog"
      aria-modal="true"
      style={{ fontFamily: THAI_FONT }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="relative grid w-full max-w-4xl max-h-[92vh] grid-cols-1 overflow-hidden rounded-[28px] border border-[#29263d] bg-[#10101b] shadow-2xl md:grid-cols-2"
      >
        {/* Left aside — brand identity (desktop only) */}
        <aside className="relative hidden overflow-hidden bg-[radial-gradient(circle_at_20%_10%,#7c3aed66,transparent_42%),linear-gradient(145deg,#18102e,#0c0b17)] p-12 md:flex md:flex-col md:justify-center md:p-13">
          <StarField />
          <AnimatedLogo />
          <h2
            className="relative z-10 font-black leading-[1.04] text-white"
            style={{ fontSize: 'clamp(36px, 5vw, 58px)' }}
          >
            เริ่มต้นพื้นที่
            <br />
            ของคุณ
          </h2>
          <p className="relative z-10 mt-6 leading-[1.7] text-[#aaa4b7]">
            สร้างบัญชีสมาชิกที่ปลอดภัย พร้อมการยืนยันทั้ง Email และเบอร์โทรศัพท์
          </p>
          <SignupStepper step={step} />
        </aside>

        {/* Right card — the existing 3-step form content */}
        <section className="relative overflow-y-auto bg-[#10101b] p-12 md:p-13">
          {step !== 3 && (
            <button
              onClick={onClose}
              className="absolute right-5 top-5 z-10 text-white/40 transition hover:text-white"
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
        </section>
      </motion.div>
    </motion.div>
  );
}
