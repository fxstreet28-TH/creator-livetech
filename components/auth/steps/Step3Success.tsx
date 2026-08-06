'use client';
import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import confetti from 'canvas-confetti';

interface Props {
  onClose: () => void;
}

export function Step3Success({ onClose }: Props) {
  const router = useRouter();

  useEffect(() => {
    confetti({
      particleCount: 120,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#8b5cf6', '#ec4899', '#ffffff'],
    });

    const t = setTimeout(() => {
      router.push('/onboarding');
      onClose();
    }, 2000);
    return () => clearTimeout(t);
  }, [router, onClose]);

  return (
    <div className="py-6 text-center">
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 18 }}
        className="mx-auto w-20 h-20 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 grid place-items-center shadow-lg shadow-purple-500/40"
      >
        <svg width="38" height="38" viewBox="0 0 24 24" fill="none" aria-hidden>
          <motion.path
            d="M4 12.5l5 5L20 6.5"
            stroke="white"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.4, delay: 0.15 }}
          />
        </svg>
      </motion.div>

      <h2 className="mt-6 text-xl font-semibold text-white">ยินดีต้อนรับสู่ AURUM Live! 🎉</h2>
      <p className="mt-2 text-sm text-white/60 leading-relaxed">
        บัญชีของคุณพร้อมใช้งานแล้ว กำลังพาไปตั้งค่าโปรไฟล์...
      </p>
    </div>
  );
}
