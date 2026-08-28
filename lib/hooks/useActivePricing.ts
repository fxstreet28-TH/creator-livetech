'use client';

/**
 * The live retail price of one star, from the wallet-pricing Edge Function.
 *
 * Every total the buy screen renders is derived from this number, so the
 * screen must not render a purchasable amount until it has arrived. There is
 * no hardcoded fallback on purpose: a stale constant in the bundle would
 * quote a price the backend then charges differently, and
 * create-payment-intent prices off star_pricing_config regardless of what the
 * client believed. Better to show a retry than to show a wrong number.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { invokeEdge, type EdgeError } from '@/lib/wallet/invoke';

interface PricingResponse {
  retail_thb_per_star: number;
  label: string;
}

export interface ActivePricing {
  /** THB the buyer pays per star, or null until loaded. */
  retailThbPerStar: number | null;
  /** Pricing row label ('launch_regular', 'flash_sale', ...). Diagnostic. */
  label: string | null;
  loading: boolean;
  error: EdgeError | null;
  reload: () => void;
}

export function useActivePricing(): ActivePricing {
  const [pricing, setPricing] = useState<PricingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<EdgeError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        // Missing Supabase env — same failure mode useDashboardUser guards
        // against. Report it as an error state, do not take the tree down.
        if (!cancelled) {
          setError({
            code: 'not_configured',
            message: 'ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง',
            detail: 'Supabase public credentials are not configured',
          });
          setLoading(false);
        }
        return;
      }

      const { data, error: invokeError } = await invokeEdge<PricingResponse>(
        supabase,
        'wallet-pricing',
        { method: 'GET' },
      );

      if (cancelled) return;

      if (invokeError || !data) {
        setError(invokeError ?? { code: 'internal_error', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
        setPricing(null);
      } else {
        // Coerced again on this side: wallet-pricing already returns a
        // number, but a NUMERIC arriving as "11.00" from any future caller
        // would silently poison every total with NaN, and Number() on a
        // number is free.
        setPricing({ ...data, retail_thb_per_star: Number(data.retail_thb_per_star) });
        setError(null);
      }
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return {
    retailThbPerStar: pricing ? pricing.retail_thb_per_star : null,
    label: pricing?.label ?? null,
    loading,
    error,
    reload,
  };
}
