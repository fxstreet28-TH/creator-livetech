'use client';
import { useState, type Dispatch, type SetStateAction } from 'react';
import type { SignupState } from '../SignupModal';
import { PhoneInput } from '../fields/PhoneInput';
import { PasswordInput } from '../fields/PasswordInput';
import { useSignupFlow } from '../hooks/useSignupFlow';
import { formatThaiPhoneE164 } from '@/lib/phone';
import { isValidEmail, validatePassword } from '@/lib/validation';

interface Props {
  state: SignupState;
  setState: Dispatch<SetStateAction<SignupState>>;
  onNext: () => void;
}

type FieldErrors = Partial<Record<'phone' | 'email' | 'password' | 'confirm', string>>;

const ERROR_COPY: Record<string, string> = {
  invalid_phone: 'เบอร์นี้ไม่ถูกต้อง',
  invalid_email: 'อีเมลไม่ถูกต้อง',
  already_registered: 'เบอร์หรืออีเมลนี้ถูกใช้งานแล้ว',
  provider_failure: 'ส่งรหัสไม่สำเร็จ กรุณาลองใหม่',
  server_error: 'เกิดข้อผิดพลาด กรุณาลองใหม่',
};

export function Step1Credentials({ state, setState, onNext }: Props) {
  const { initSignup } = useSignupFlow();
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = <K extends keyof SignupState>(key: K, value: SignupState[K]) =>
    setState((s) => ({ ...s, [key]: value }));

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!formatThaiPhoneE164(state.phone)) next.phone = 'กรุณากรอกเบอร์มือถือไทยให้ถูกต้อง';
    if (!isValidEmail(state.email.trim())) next.email = 'กรุณากรอกอีเมลให้ถูกต้อง';
    const pw = validatePassword(state.password);
    if (!pw.ok) {
      next.password =
        pw.reason === 'too_short'
          ? 'รหัสผ่านอย่างน้อย 8 ตัวอักษร'
          : 'ต้องมีทั้งตัวอักษรและตัวเลข';
    }
    if (confirm !== state.password) next.confirm = 'รหัสผ่านไม่ตรงกัน';
    return next;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setLoading(true);
    const res = await initSignup({
      phone: state.phone,
      email: state.email.trim(),
      password: state.password,
    });
    setLoading(false);

    if (res.ok && res.sessionId) {
      setState((s) => ({
        ...s,
        sessionId: res.sessionId!,
        phoneMasked: res.phoneMasked ?? '',
        emailMasked: res.emailMasked ?? '',
        smsSent: res.smsSent ?? true,
        emailSent: res.emailSent ?? true,
      }));
      onNext();
      return;
    }

    if (res.status === 429) {
      const mins = Math.ceil((res.retryAfterSeconds ?? 3600) / 60);
      setFormError(`คุณส่งคำขอบ่อยเกินไป กรุณาลองใหม่ในอีก ${mins} นาที`);
      return;
    }
    setFormError(ERROR_COPY[res.error ?? 'server_error'] ?? ERROR_COPY.server_error);
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-white">เริ่มต้นเป็น Creator กับ AURUM Live</h2>
      <p className="mt-2 text-sm text-white/60 leading-relaxed">
        สร้างรายได้จากการไลฟ์ คอนเทนต์ และคอมมูนิตี้ของคุณ
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <Field label="เบอร์โทรศัพท์" error={errors.phone}>
          <PhoneInput
            value={state.phone}
            onChange={(v) => set('phone', v)}
            error={!!errors.phone}
          />
        </Field>

        <Field label="อีเมล" error={errors.email}>
          <input
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={state.email}
            onChange={(e) => set('email', e.target.value)}
            className={`w-full h-12 rounded-xl bg-[#0a0a15]/60 border px-3 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-purple-500 transition text-[15px] ${
              errors.email ? 'border-red-500' : 'border-white/10'
            }`}
          />
        </Field>

        <Field label="รหัสผ่าน" error={errors.password}>
          <PasswordInput
            value={state.password}
            onChange={(v) => set('password', v)}
            error={!!errors.password}
            placeholder="อย่างน้อย 8 ตัวอักษร"
            showStrength
          />
        </Field>

        <Field label="ยืนยันรหัสผ่าน" error={errors.confirm}>
          <PasswordInput
            value={confirm}
            onChange={setConfirm}
            error={!!errors.confirm}
            placeholder="พิมพ์รหัสผ่านอีกครั้ง"
          />
        </Field>

        {formError && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {formError}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full h-12 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'กำลังส่ง...' : 'ส่งรหัสยืนยัน'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-white/60">
        มีบัญชีอยู่แล้ว?{' '}
        <a href="/login" className="text-purple-400 font-medium hover:text-purple-300">
          เข้าสู่ระบบ
        </a>
      </p>
      <p className="mt-3 text-center text-[11px] text-white/40 leading-relaxed">
        โดยการสมัครสมาชิก คุณยอมรับ{' '}
        <a href="/terms" className="underline hover:text-white/60">
          ข้อกำหนดการใช้งาน
        </a>{' '}
        และ{' '}
        <a href="/privacy" className="underline hover:text-white/60">
          นโยบายความเป็นส่วนตัว
        </a>
      </p>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-white/80 mb-3">{label}</label>
      {children}
      {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
    </div>
  );
}
