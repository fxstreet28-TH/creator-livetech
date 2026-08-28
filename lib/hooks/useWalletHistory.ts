'use client';

/**
 * Everything that has happened to the caller's stars, for the wallet page's
 * three history tabs.
 *
 * Purchases and buybacks are read straight from their tables with the browser
 * client rather than through an Edge Function. Both carry a read-own RLS
 * policy and a SELECT grant for `authenticated` (Week 3 migrations), so the
 * database is what scopes the rows — an Edge Function in front of them would
 * add a hop and a second place for the filter to be wrong. The ledger goes
 * through wallet-transactions because that endpoint already exists and does
 * its own pagination.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { invokeEdge } from '@/lib/wallet/invoke';

/** Rows shown per tab. Deep history is a later concern than this PR. */
const HISTORY_LIMIT = 50;

export interface PurchaseEntry {
  id: string;
  stars: number;
  amountThb: number;
  /** star_payment_intents.status */
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | string;
  createdAt: string;
  paidAt: string | null;
}

export interface BuybackEntry {
  id: string;
  stars: number;
  totalThb: number;
  /** buyback_requests.status — 'approved' is the DB's in-progress state. */
  status: 'pending' | 'approved' | 'paid' | 'rejected' | 'cancelled' | string;
  bankName: string | null;
  bankAccountNumber: string | null;
  requestedAt: string;
  processedAt: string | null;
  rejectionReason: string | null;
}

export interface LedgerEntry {
  id: string;
  type: string;
  starsDelta: number;
  createdAt: string;
}

export interface WalletHistory {
  purchases: PurchaseEntry[];
  buybacks: BuybackEntry[];
  /**
   * Ledger rows that are NOT already represented by a purchase or buyback
   * row — spends, tips, expirations. Filtered here rather than at render
   * time so the combined tab cannot double-count one event: a succeeded
   * purchase writes both a star_payment_intents row and a star_transactions
   * row of type 'purchase', and showing both would tell the user they bought
   * twice.
   */
  ledger: LedgerEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Ledger types that duplicate a row already sourced from its own table. */
const DUPLICATED_LEDGER_TYPES = new Set(['purchase', 'buyback']);

export function useWalletHistory(): WalletHistory {
  const [purchases, setPurchases] = useState<PurchaseEntry[]>([]);
  const [buybacks, setBuybacks] = useState<BuybackEntry[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        if (!cancelled) {
          setError('ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง');
          setLoading(false);
        }
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) {
        if (!cancelled) {
          setError('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
          setLoading(false);
        }
        return;
      }

      // Three independent reads, so they go out together rather than in
      // sequence — the tabs render as one screen and there is no ordering
      // dependency between them.
      const [purchaseRes, buybackRes, ledgerRes] = await Promise.all([
        supabase
          .from('star_payment_intents')
          .select('id, stars, amount_thb, status, created_at, paid_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(HISTORY_LIMIT),
        supabase
          .from('buyback_requests')
          .select(
            'id, star_amount, total_thb, status, bank_name, bank_account_number, requested_at, processed_at, rejection_reason',
          )
          .eq('user_id', userId)
          .order('requested_at', { ascending: false })
          .limit(HISTORY_LIMIT),
        invokeEdge<{ transactions: Array<Record<string, unknown>> }>(
          supabase,
          'wallet-transactions',
          { method: 'GET' },
        ),
      ]);

      if (cancelled) return;

      // A failure in any one read is reported, but the others still render.
      // A user checking whether their buyback landed should not be shown an
      // empty screen because the ledger endpoint was briefly unhappy.
      const failures: string[] = [];

      if (purchaseRes.error) {
        console.error('[useWalletHistory] purchases', purchaseRes.error);
        failures.push('ประวัติการซื้อ');
      } else {
        setPurchases(
          (purchaseRes.data ?? []).map((row) => ({
            id: String(row.id),
            stars: Number(row.stars),
            // NUMERIC arrives as a string; without Number() the totals sort
            // and render as text.
            amountThb: Number(row.amount_thb),
            status: String(row.status),
            createdAt: String(row.created_at),
            paidAt: row.paid_at ? String(row.paid_at) : null,
          })),
        );
      }

      if (buybackRes.error) {
        console.error('[useWalletHistory] buybacks', buybackRes.error);
        failures.push('ประวัติ buyback');
      } else {
        setBuybacks(
          (buybackRes.data ?? []).map((row) => ({
            id: String(row.id),
            stars: Number(row.star_amount),
            totalThb: Number(row.total_thb),
            status: String(row.status),
            bankName: row.bank_name ? String(row.bank_name) : null,
            bankAccountNumber: row.bank_account_number ? String(row.bank_account_number) : null,
            requestedAt: String(row.requested_at),
            processedAt: row.processed_at ? String(row.processed_at) : null,
            rejectionReason: row.rejection_reason ? String(row.rejection_reason) : null,
          })),
        );
      }

      if (ledgerRes.error || !ledgerRes.data) {
        console.error('[useWalletHistory] ledger', ledgerRes.error);
        failures.push('ประวัติการใช้งาน');
      } else {
        setLedger(
          (ledgerRes.data.transactions ?? [])
            .map((row) => ({
              id: String(row.id),
              type: String(row.transaction_type),
              starsDelta: Number(row.stars_delta),
              createdAt: String(row.created_at),
            }))
            .filter((entry) => !DUPLICATED_LEDGER_TYPES.has(entry.type)),
        );
      }

      setError(failures.length > 0 ? `โหลด${failures.join(' และ ')}ไม่สำเร็จ` : null);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { purchases, buybacks, ledger, loading, error, refresh };
}
