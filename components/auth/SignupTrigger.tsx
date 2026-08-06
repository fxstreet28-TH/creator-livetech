'use client';
import { useState } from 'react';
import { SignupModal } from './SignupModal';

interface SignupTriggerProps {
  className?: string;
  children: React.ReactNode;
}

/**
 * Client wrapper that renders a trigger button and owns the modal open state.
 * Drop-in replacement for the existing landing-page CTA anchors — pass the same
 * className (e.g. "button" / "button small") to keep the gradient styling.
 */
export function SignupTrigger({ className, children }: SignupTriggerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      <SignupModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
