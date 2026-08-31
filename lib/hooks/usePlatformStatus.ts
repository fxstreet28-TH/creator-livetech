'use client';

/**
 * The platform kill-switch status, re-read every minute.
 *
 * Mounted once by the banner in the root layout, and again by the two creator
 * screens that gate on it. That is three readers of a four-column view with a
 * one-minute poll — cheap enough that sharing one instance through context
 * would be more machinery than it saves, and each screen stays independently
 * correct if the layout ever changes.
 *
 * The poll pauses while the tab is hidden: a backgrounded tab that keeps
 * asking is pure cost, and the status is re-read the moment it comes back,
 * which is the only moment anyone could see it.
 */

import { useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import {
  fetchPlatformStatus,
  PLATFORM_STATUS_POLL_MS,
  type PlatformStatus,
} from '@/lib/platform/status';

export interface PlatformStatusResult {
  status: PlatformStatus | null;
  /** True until the first read settles, however it settles. */
  loading: boolean;
}

export function usePlatformStatus(): PlatformStatusResult {
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function read() {
      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        // No credentials configured: nothing to poll, and no banner.
        if (!cancelled) setLoading(false);
        return;
      }

      const result = await fetchPlatformStatus(supabase);
      if (cancelled) return;
      setStatus(result);
      setLoading(false);
    }

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => void read(), PLATFORM_STATUS_POLL_MS);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void read();
        start();
      } else {
        stop();
      }
    };

    void read();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return { status, loading };
}
