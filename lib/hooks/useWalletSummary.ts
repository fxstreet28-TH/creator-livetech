'use client';

/**
 * The caller's star balance and upcoming expiry batches, from wallet-get.
 *
 * Shared by three screens with three different reasons for wanting it: the
 * wallet page renders it, the buy screen needs it to enforce the 50,000-star
 * AML cap client-side before opening a PaymentIntent, and the buyback form
 * needs it as the upper bound on what can be sold.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { invokeEdge, type EdgeError } from '@/lib/wallet/invoke';

export interface UpcomingExpiration {
  id: string;
  remaining_stars: number;
  expires_at: string;
  thb_amount: number;
}

export interface WalletTotals {
  total_balance: number;
  total_purchased: number;
  total_spent: number;
  total_expired: number;
  total_bought_back: number;
  updated_at: string | null;
}

interface WalletResponse {
  wallet: WalletTotals;
  upcoming_expirations: UpcomingExpiration[];
}

export interface WalletSummary {
  wallet: WalletTotals | null;
  upcomingExpirations: UpcomingExpiration[];
  /** Convenience: the balance, or 0 while loading / on error. */
  balance: number;
  /**
   * Whether `balance` is a real figure rather than the zero placeholder.
   *
   * Callers MUST check this before treating the balance as fact. A failed
   * wallet-get reporting 0 is indistinguishable from an empty wallet, and
   * "0" is the one value that silently breaks every rule derived from it —
   * it makes the buyback form reject every valid amount as insufficient and
   * makes the purchase cap check compare against the wrong ceiling.
   */
  balanceKnown: boolean;
  loading: boolean;
  error: EdgeError | null;
  /** Re-fetch. The buy screen calls this from its manual-refresh fallback. */
  refresh: () => void;
}

/**
 * wallet-get returns NUMERIC columns (thb_amount) as strings and INTEGER
 * columns as numbers. Only the integers are arithmetic here, but thb_amount
 * is rendered, so both are normalised at the boundary rather than at each
 * use site.
 */
function normalise(data: WalletResponse): WalletResponse {
  return {
    wallet: {
      ...data.wallet,
      total_balance: Number(data.wallet.total_balance ?? 0),
      total_purchased: Number(data.wallet.total_purchased ?? 0),
      total_spent: Number(data.wallet.total_spent ?? 0),
      total_expired: Number(data.wallet.total_expired ?? 0),
      total_bought_back: Number(data.wallet.total_bought_back ?? 0),
    },
    upcoming_expirations: (data.upcoming_expirations ?? []).map((batch) => ({
      ...batch,
      remaining_stars: Number(batch.remaining_stars),
      thb_amount: Number(batch.thb_amount),
    })),
  };
}

export function useWalletSummary(): WalletSummary {
  const [data, setData] = useState<WalletResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<EdgeError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
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

      const { data: body, error: invokeError } = await invokeEdge<WalletResponse>(
        supabase,
        'wallet-get',
        { method: 'GET' },
      );

      if (cancelled) return;

      if (invokeError || !body) {
        setError(invokeError ?? { code: 'internal_error', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
      } else {
        setData(normalise(body));
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
    wallet: data?.wallet ?? null,
    upcomingExpirations: data?.upcoming_expirations ?? [],
    balance: data?.wallet.total_balance ?? 0,
    balanceKnown: data !== null && error === null,
    loading,
    error,
    refresh,
  };
}
