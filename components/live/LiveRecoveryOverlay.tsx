'use client';

/**
 * What the viewer sees while the page is repairing itself.
 *
 * Every rung of the recovery ladder looks the same from a sofa: a dark
 * rectangle. A viewer cannot tell "trying something else in six seconds" from
 * "this is never going to work", so without a clock they leave during the
 * retry that would have fixed it. The countdown is not decoration — it is the
 * reason the ladder gets the thirty-five seconds it needs.
 *
 * COPY RULES, both of them deliberate:
 *
 *  - No jargon, and no numbers that mean nothing to a person. Not "ICE relay",
 *    not "rebuilding decoder", not an error code. A viewer cannot act on any
 *    of it, and every one of those words makes the app look broken rather than
 *    busy. The step is recorded in the diagnostics table, where someone who
 *    can act on it will actually look.
 *  - The last card gives exactly two things to do, in order of how likely they
 *    are to work: tap the button, and if that fails, close the browser app and
 *    open it again. That second line is the whole reason this feature exists —
 *    it is what somebody had to be told by hand today.
 */

import { Loader2, RotateCw, WifiOff } from 'lucide-react';
import type { RecoveryStep } from '@/lib/live/useRecoveryLadder';

interface LiveRecoveryOverlayProps {
  step: RecoveryStep;
  secondsToNextStep: number | null;
  exhausted: boolean;
  onRetry: () => void;
  /** The ordinary copy for this phase, e.g. 'กำลังโหลดไลฟ์...'. */
  message: string;
  /** Underneath the message: the wait counter the HLS player already shows. */
  detail?: React.ReactNode;
}

export function LiveRecoveryOverlay({
  step,
  secondsToNextStep,
  exhausted,
  onRetry,
  message,
  detail,
}: LiveRecoveryOverlayProps) {
  if (exhausted) {
    return (
      <div
        role="alert"
        // Interactive, unlike every other overlay on this player: it is the
        // only one with something to press, and a pointer-events-none error
        // card with a button on it would be a cruel joke.
        className="absolute inset-0 z-30 grid place-items-center bg-black/90 px-6 text-center"
      >
        <div className="w-full max-w-xs">
          <WifiOff size={32} className="mx-auto text-rose-300" aria-hidden />
          <p className="mt-4 text-lg font-semibold text-white">เชื่อมต่อวิดีโอไม่สำเร็จ</p>

          <button
            type="button"
            onClick={onRetry}
            // Big, because it is the only thing to do and a viewer is
            // probably holding the phone one-handed by now.
            className="mt-5 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-cyan-500 px-6 text-base font-semibold text-black transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          >
            <RotateCw size={18} aria-hidden />
            แตะเพื่อลองใหม่
          </button>

          {/* Not a link element: it navigates nowhere, and a link that does
              nothing when tapped is worse than a sentence. */}
          <p className="mt-4 text-xs leading-relaxed text-white/50">
            ยังไม่ได้? ปิดแอป Safari/Chrome แล้วเปิดใหม่
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/75 px-6 text-center">
      <div>
        <Loader2 size={28} className="mx-auto animate-spin text-cyan-300" aria-hidden />
        <p className="mt-3 text-sm text-white/80" role="status">
          {message}
        </p>
        {detail}
        {/*
          Only once the ladder has actually escalated. During the first eight
          seconds an ordinary connect is still running, and putting a retry
          countdown on that would tell a viewer something is wrong before
          anything is.
        */}
        {step !== 'normal' && secondsToNextStep !== null && (
          <p className="mt-2 text-xs tabular-nums text-white/45" role="status">
            กำลังลองใหม่ให้อัตโนมัติ · {secondsToNextStep} วินาที
          </p>
        )}
      </div>
    </div>
  );
}
