'use client';

interface PhoneInputProps {
  value: string; // raw local digits, e.g. "0812345678"
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: boolean;
  id?: string;
}

/** Format local Thai digits as "08X XXX XXXX" for display. */
function formatDisplay(digits: string): string {
  const d = digits.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

export function PhoneInput({ value, onChange, onBlur, error, id }: PhoneInputProps) {
  return (
    <div
      className={`flex items-center gap-2 rounded-[13px] bg-[#0a0a12] border px-[15px] py-[14px] transition focus-within:border-[#8b5cf6] focus-within:ring-2 focus-within:ring-[#7c3aed33] ${
        error ? 'border-red-500' : 'border-[#353145]'
      }`}
    >
      <span className="text-white/60 text-sm font-medium select-none border-r border-white/10 pr-2">
        +66
      </span>
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        dir="ltr"
        placeholder="08X XXX XXXX"
        value={formatDisplay(value)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
        onBlur={onBlur}
        className="flex-1 bg-transparent text-white placeholder:text-white/30 focus:outline-none text-[15px]"
      />
    </div>
  );
}
