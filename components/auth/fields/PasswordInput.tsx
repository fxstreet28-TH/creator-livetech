'use client';
import { useState } from 'react';
import { passwordStrength } from '@/lib/validation';

interface PasswordInputProps {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: boolean;
  placeholder?: string;
  showStrength?: boolean;
  id?: string;
  autoComplete?: string;
}

const STRENGTH_LABEL = ['อ่อน', 'พอใช้', 'ดี', 'แข็งแรง'];
const STRENGTH_COLOR = ['bg-red-500', 'bg-amber-500', 'bg-lime-500', 'bg-green-500'];

export function PasswordInput({
  value,
  onChange,
  onBlur,
  error,
  placeholder,
  showStrength,
  id,
  autoComplete = 'new-password',
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const score = passwordStrength(value);

  return (
    <div>
      <div
        className={`flex items-center gap-2 h-12 rounded-xl bg-[#0a0a15]/60 border px-3 transition focus-within:ring-2 focus-within:ring-purple-500 ${
          error ? 'border-red-500' : 'border-white/10'
        }`}
      >
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className="flex-1 bg-transparent text-white placeholder:text-white/30 focus:outline-none text-[15px]"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="text-white/40 hover:text-white text-xs font-medium select-none"
          tabIndex={-1}
          aria-label={visible ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
        >
          {visible ? 'ซ่อน' : 'แสดง'}
        </button>
      </div>

      {showStrength && value.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 flex gap-1">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition ${
                  i < score ? STRENGTH_COLOR[Math.min(score - 1, 3)] : 'bg-white/10'
                }`}
              />
            ))}
          </div>
          <span className="text-[11px] text-white/50 w-12 text-right">
            {score > 0 ? STRENGTH_LABEL[Math.min(score - 1, 3)] : ''}
          </span>
        </div>
      )}
    </div>
  );
}
