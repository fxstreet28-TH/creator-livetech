'use client';
import { useCallback, useEffect, useState } from 'react';

/**
 * Simple 1s-tick countdown for OTP resend cooldowns.
 * `start(n)` (re)arms the timer to n seconds; `seconds` ticks down to 0.
 */
export function useCountdown(initial = 0) {
  const [seconds, setSeconds] = useState(initial);

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setTimeout(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [seconds]);

  const start = useCallback((s: number) => setSeconds(Math.max(0, Math.floor(s))), []);

  return { seconds, start, active: seconds > 0 };
}
