'use client';

interface SignupStepperProps {
  /** Current active step from SignupModal (1–3). */
  step: 1 | 2 | 3;
}

const STEPS = ['ข้อมูลบัญชี', 'ยืนยันตัวตน', 'เสร็จสิ้น'];

/**
 * Vertical 3-step indicator for the modal's left aside. A step is "active"
 * once the flow has reached it (current + completed steps stay filled).
 */
export function SignupStepper({ step }: SignupStepperProps) {
  return (
    <div className="relative z-10 mt-11 grid gap-4">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const active = n <= step;
        return (
          <div key={n} className="flex items-center gap-4">
            <span
              className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full border text-sm font-bold transition-colors ${
                active
                  ? 'border-[#a78bfa] bg-[#7c3aed] text-white'
                  : 'border-[#3d3951] bg-transparent text-[#8f899f]'
              }`}
            >
              {n}
            </span>
            <span
              className={`text-[15px] transition-colors ${
                active ? 'text-white' : 'text-[#8f899f]'
              }`}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
