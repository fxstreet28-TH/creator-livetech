'use client';

/**
 * The signed-in creator's quota snapshot, fetched fresh on every mount.
 *
 * Four screens need the same three reads — the dashboard widget,
 * /creator/quota, and the upload and live gates — so they share one hook
 * rather than four copies of the same Promise.all. Nothing is cached between
 * mounts (non-negotiable #4): the counters move whenever an upload finishes
 * or a live ends, and a stale "3 / 5" is exactly the surprise the widget
 * exists to prevent.
 *
 * `creatorId` is creators.id, from useCreatorProfile. A null id (a signed-in
 * viewer who is not a creator) resolves immediately with no snapshot — the
 * screens above all hide themselves in that case.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { fetchCreatorQuota, type CreatorQuotaSnapshot } from '@/lib/creator/quota';

export interface CreatorQuotaResult {
  snapshot: CreatorQuotaSnapshot | null;
  loading: boolean;
  /** Thai, renderable. Null when the read succeeded. */
  error: string | null;
  /** Re-read after something that moves a counter. */
  refresh: () => void;
}

export function useCreatorQuota(creatorId: string | null): CreatorQuotaResult {
  const [snapshot, setSnapshot] = useState<CreatorQuotaSnapshot | null>(null);
  const [loading, setLoading] = useState(creatorId !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  // No read without a creator, and no setState here either: the not-a-creator
  // shape is derived at the return instead, which keeps this a pure "talk to
  // an external system" effect. Same reasoning as useCreatorProfile.
  useEffect(() => {
    if (!creatorId) return;

    let cancelled = false;

    async function load() {
      setLoading(true);

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

      const { snapshot: result, error: readError } = await fetchCreatorQuota(
        supabase,
        creatorId as string,
      );
      if (cancelled) return;

      setSnapshot(result);
      setError(readError);
      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [creatorId, nonce]);

  const hasCreator = creatorId !== null;

  return {
    snapshot: hasCreator ? snapshot : null,
    loading: hasCreator && loading,
    error: hasCreator ? error : null,
    refresh,
  };
}
