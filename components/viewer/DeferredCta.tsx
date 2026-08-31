'use client';

/**
 * A button for a flow that has not shipped yet: subscribe, PPV unlock, follow,
 * tip. Pressing it reveals a Thai sentence under the button saying when it
 * will work, and nothing else happens.
 *
 * One component rather than four copies of the same useState, and an inline
 * note rather than a tooltip or a toast for two reasons. This repo has no
 * toast system and the brief forbids adding one; and a tooltip is a hover
 * affordance, so on the phone these screens are designed for it would either
 * never appear or appear and never dismiss.
 *
 * The note is aria-live so a screen reader hears the refusal — a button that
 * silently does nothing reads as broken.
 *
 * TODO(day-8): replace each usage with the real flow — subscribe and PPV
 * unlock land with the subscription plan UI, tipping with the wallet debit.
 */

import { useState } from 'react';

interface DeferredCtaProps {
  label: string;
  /** Thai sentence shown once the button is pressed. */
  notice: string;
  icon?: React.ReactNode;
  variant?: 'primary' | 'secondary';
  className?: string;
}

const VARIANT_CLASS = {
  primary:
    'bg-gradient-to-r from-purple-500 to-pink-500 text-white hover:shadow-lg hover:shadow-purple-500/40',
  secondary: 'border border-white/12 bg-white/[0.04] text-white/85 hover:bg-white/[0.08]',
} as const;

export function DeferredCta({
  label,
  notice,
  icon,
  variant = 'primary',
  className = '',
}: DeferredCtaProps) {
  const [shown, setShown] = useState(false);

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setShown(true)}
        className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${VARIANT_CLASS[variant]}`}
      >
        {icon}
        {label}
      </button>
      <p aria-live="polite" className="mt-2 min-h-0 text-center text-xs leading-relaxed text-white/50">
        {shown ? notice : ''}
      </p>
    </div>
  );
}
