'use client';

/**
 * The gift catalogue, for the drawer and for anything else that needs to name
 * a tier.
 *
 * Loaded LAZILY — pass `enabled: false` until the viewer opens the drawer. A
 * live page already makes several calls before the video plays, and the
 * catalogue is only needed the moment somebody decides to spend; fetching it on
 * mount would put a request in front of the thing every viewer came for, for
 * the benefit of the few who gift.
 *
 * Loaded ONCE and then kept. It is seven rows that change when the CEO edits a
 * price, not per-session state, so re-opening the drawer must not re-fetch it.
 *
 * The rows are the authority on price. Nothing derived from them is cached
 * across a price change, because there is nothing to cache: the drawer reads
 * `price_stars` off the row it was handed, and the server prices the spend off
 * the same row a moment later.
 */

import { useCallback, useEffect, useState } from 'react';
import { fetchGiftTiers, type GiftTier } from '@/lib/live/gifts';
import { getBrowserSupabase } from '@/lib/supabase-browser';

export interface GiftTiersResult {
  tiers: GiftTier[];
  loading: boolean;
  /** Thai, renderable. */
  error: string | null;
  refresh: () => void;
}

interface CatalogueState {
  tiers: GiftTier[];
  error: string | null;
  /** True once a load has finished, successfully or not. */
  settled: boolean;
}

const EMPTY: CatalogueState = { tiers: [], error: null, settled: false };

export function useGiftTiers(enabled: boolean): GiftTiersResult {
  /**
   * One state object rather than three.
   *
   * `loading` is DERIVED from it — `enabled && !settled` — rather than being a
   * fourth flag flipped at the top of the effect. Setting a flag synchronously
   * in an effect body is the cascading-render pattern React's own lint rule
   * objects to, and here it is not even needed: "asked for, not answered yet"
   * is exactly what those two values already say.
   */
  const [state, setState] = useState<CatalogueState>(EMPTY);

  const refresh = useCallback(() => setState(EMPTY), []);

  useEffect(() => {
    if (!enabled || state.settled) return;

    let cancelled = false;

    async function load() {
      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        if (!cancelled) {
          setState({ tiers: [], error: 'ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง', settled: true });
        }
        return;
      }

      const { tiers, error } = await fetchGiftTiers(supabase);
      if (cancelled) return;
      setState({ tiers, error, settled: true });
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, state.settled]);

  return {
    tiers: state.tiers,
    loading: enabled && !state.settled,
    error: state.error,
    refresh,
  };
}
