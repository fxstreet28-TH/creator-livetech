'use client';

/**
 * The two numbers in the dashboard hero: how many creators the user follows,
 * and how many active subscriptions they hold.
 *
 * Both were hardcoded to 0 before this; they are real reads now. Both tables
 * are RLS-scoped to the caller's own rows (`auth.uid() = follower_id`,
 * `auth.uid() = subscriber_id`), so no filter is needed here — the one on
 * `subscriptions` is about which rows COUNT, not which are visible: a
 * cancelled or lapsed subscription is still the user's row.
 *
 * `head: true` with `count: 'exact'` sends no rows over the wire, only the
 * Content-Range header, which is what these two numbers need.
 *
 * A failure resolves to 0 rather than an error state. The hero is a greeting;
 * two zeroes are a mild inaccuracy, an error banner across the top of the
 * homepage is not.
 */

import { useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';

export interface ViewerCounts {
  followingCount: number;
  subscriptionCount: number;
  loading: boolean;
}

export function useViewerCounts(): ViewerCounts {
  const { user, loading: userLoading } = useDashboardUser();
  const userId = user?.id ?? null;

  const [counts, setCounts] = useState({ followingCount: 0, subscriptionCount: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (userLoading || !userId) return;

    let cancelled = false;

    async function load() {
      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        if (!cancelled) setLoading(false);
        return;
      }

      const [follows, subscriptions] = await Promise.all([
        supabase.from('follows').select('id', { count: 'exact', head: true }),
        supabase
          .from('subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active')
          .gt('expires_at', new Date().toISOString()),
      ]);

      if (cancelled) return;

      if (follows.error) console.error('[useViewerCounts] follows count failed', follows.error);
      if (subscriptions.error) {
        console.error('[useViewerCounts] subscriptions count failed', subscriptions.error);
      }

      setCounts({
        followingCount: follows.count ?? 0,
        subscriptionCount: subscriptions.count ?? 0,
      });
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [userId, userLoading]);

  return {
    followingCount: userId ? counts.followingCount : 0,
    subscriptionCount: userId ? counts.subscriptionCount : 0,
    loading: userLoading || (userId !== null && loading),
  };
}
