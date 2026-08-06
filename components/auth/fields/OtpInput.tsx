'use client';
import { useRef, type KeyboardEvent, type ClipboardEvent } from 'react';

interface OtpInputProps {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
  error?: boolean;
}

export function OtpInput({ value, onChange, length = 6, autoFocus, error }: OtpInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const setChar = (i: number, ch: string) => {
    const next = value.split('');
    while (next.length < length) next.push('');
    next[i] = ch.replace(/\D/g, '').slice(0, 1);
    onChange(next.join('').slice(0, length));
    if (ch && i < length - 1) refs.current[i + 1]?.focus();
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (pasted) {
      onChange(pasted);
      refs.current[Math.min(pasted.length, length - 1)]?.focus();
    }
  };

  return (
    <div className="flex gap-2 justify-between" dir="ltr">
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          value={value[i] ?? ''}
          onChange={(e) => setChar(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          autoFocus={autoFocus && i === 0}
          aria-label={`หลักที่ ${i + 1}`}
          className={`w-12 h-14 text-center text-2xl font-semibold bg-[#0a0a15]/60 border rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-purple-500 transition ${
            error ? 'border-red-500' : 'border-white/10'
          }`}
        />
      ))}
    </div>
  );
}
