'use client';
import { useState } from 'react';
import { motion } from 'framer-motion';
import type { SignupState } from '../SignupModal';
import { OtpInput } from '../fields/OtpInput';
import { useSignupFlow } from '../hooks/useSignupFlow';
import { useCountdown } from '../hooks/useCountdown';
import { getBrowserSupabase } from '@/lib/supabase-browser';

interface Props {
  state: SignupState;
  onBack: () => void;
  onNext: () => void;
}

const RESEND_SECONDS = 60;

export function Step2Verify({ state, onBack, onNext }: Props) {
  const { completeSignup, resend } = useSignupFlow();
  const [smsCode, setSmsCode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [smsError, setSmsError] = useState(false);
  const [emailError, setEmailError] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);

  const smsTimer = useCountdown(RESEND_SECONDS);
  const emailTimer = useCountdown(RESEND_SECONDS);

  const canSubmit = smsCode.length === 6 && emailCode.length === 6 && !loading;

  const doResend = async (channel: 'sms' | 'email') => {
    if (!state.sessionId) return;
    setFormError(null);
    const res = await resend(state.sessionId, channel);
    if (res.ok) {
      (channel === 'sms' ? smsTimer : emailTimer).start(RESEND_SECONDS);
    } else if (res.status === 429) {
      (channel === 'sms' ? smsTimer : emailTimer).start(res.retryAfterSeconds ?? RESEND_SECONDS);
    } else {
      setFormError('ส่งรหัสใหม่ไม่สำเร็จ กรุณาลองใหม่');
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state.sessionId || !canSubmit) return;
    setFormError(null);
    setSmsError(false);
    setEmailError(false);
    setLoading(true);

    const res = await completeSignup({
      sessionId: state.sessionId,
      smsCode,
      emailCode,
    });
    setLoading(false);

    if (res.ok && res.accessToken && res.refreshToken) {
      try {
        await getBrowserSupabase().auth.setSession({
          access_token: res.accessToken,
          refresh_token: res.refreshToken,
        });
      } catch {
        // Session set is best-effort; account exists regardless.
      }
      onNext();
      return;
    }

    if (res.status === 400 && res.error === 'code_invalid') {
      setSmsError(!!res.smsInvalid);
      setEmailError(!!res.emailInvalid);
      setShakeKey((k) => k + 1);
      if (res.smsInvalid && res.emailInvalid) setFormError('รหัสไม่ถูกต้อง');
      else if (res.smsInvalid) setFormError('รหัส SMS ไม่ถูกต้อง');
      else setFormError('รหัสอีเมลไม่ถูกต้อง');
      return;
    }
    if (res.error === 'too_many_attempts') {
      setFormError('พยายามหลายครั้งเกินไป กรุณาขอรหัสใหม่');
      return;
    }
    if (res.status === 410 || res.error === 'expired') {
      setFormError('รหัสหมดอายุแล้ว กรุณาขอรหัสใหม่');
      smsTimer.start(0);
      emailTimer.start(0);
      return;
    }
    setFormError('เกิดข้อผิดพลาด กรุณาลองใหม่');
  };

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-white/50 hover:text-white transition"
      >
        ← แก้ไขข้อมูล
      </button>

      <h2 className="m-0 mb-2 mt-4 font-bold text-white" style={{ fontSize: '32px' }}>
        ยืนยันตัวตน
      </h2>
      <p className="text-sm text-white/60 leading-relaxed">
        เราได้ส่งรหัส 6 หลักไปยังเบอร์และอีเมลของคุณแล้ว
      </p>

      {(state.smsSent === false || state.emailSent === false) && (
        <p className="mt-3 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          {state.smsSent === false
            ? 'ส่ง SMS ไม่สำเร็จ กรุณากด "ส่งใหม่" ที่ช่อง SMS'
            : 'ส่งอีเมลไม่สำเร็จ กรุณากด "ส่งใหม่" ที่ช่องอีเมล'}
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-6">
        <motion.div
          key={`sms-${shakeKey}`}
          animate={smsError ? { x: [0, -8, 8, -6, 6, 0] } : {}}
          transition={{ duration: 0.35 }}
        >
          <label className="block text-sm font-medium text-white/80 mb-3">รหัสจาก SMS</label>
          <OtpInput value={smsCode} onChange={setSmsCode} error={smsError} autoFocus />
          <div className="mt-2 flex items-center justify-between text-xs text-white/50">
            <span>ส่งไปที่ {state.phoneMasked || '+66 8X-XXX-XXXX'}</span>
            <ResendButton timer={smsTimer} onClick={() => doResend('sms')} />
          </div>
        </motion.div>

        <motion.div
          key={`email-${shakeKey}`}
          animate={emailError ? { x: [0, -8, 8, -6, 6, 0] } : {}}
          transition={{ duration: 0.35 }}
        >
          <label className="block text-sm font-medium text-white/80 mb-3">รหัสจากอีเมล</label>
          <OtpInput value={emailCode} onChange={setEmailCode} error={emailError} />
          <div className="mt-2 flex items-center justify-between text-xs text-white/50">
            <span>ส่งไปที่ {state.emailMasked || 'อีเมลของคุณ'}</span>
            <ResendButton timer={emailTimer} onClick={() => doResend('email')} />
          </div>
        </motion.div>

        {formError && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {formError}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full h-12 rounded-[13px] bg-gradient-to-r from-purple-500 to-pink-500 text-white font-extrabold shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'กำลังยืนยัน...' : 'ยืนยัน'}
        </button>
      </form>
    </div>
  );
}

function ResendButton({
  timer,
  onClick,
}: {
  timer: { seconds: number; active: boolean };
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={timer.active}
      className="text-purple-400 hover:text-purple-300 disabled:text-white/30 disabled:cursor-not-allowed font-medium"
    >
      {timer.active ? `ส่งใหม่ (${timer.seconds})` : 'ส่งใหม่'}
    </button>
  );
}
