'use client';

/**
 * The signed-in user's creator row, or null if they do not have one.
 *
 * Every creator screen needs this before it can do anything: `feed_posts.
 * creator_id` is `creators.id`, not `auth.users.id`, so "my posts" cannot be
 * expressed without one extra read. RLS ("Users can read their own creator
 * row") scopes it, so the filter here is a convenience, not the boundary.
 */

import { useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';

export interface CreatorProfile {
  creatorId: string | null;
  /** content_tier_limits.tier — 'free' | 'pro' | 'star' | 'enterprise'. */
  contentTier: string | null;
  displayName: string | null;
  /** True once the lookup has resolved, whether or not a row was found. */
  loading: boolean;
  /** Thai, renderable. Null when the read succeeded. */
  error: string | null;
}

export function useCreatorProfile(): CreatorProfile {
  const { user, loading: userLoading } = useDashboardUser();
  const [profile, setProfile] = useState<Omit<CreatorProfile, 'loading' | 'error'>>({
    creatorId: null,
    contentTier: null,
    displayName: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const userId = user?.id ?? null;

  useEffect(() => {
    if (userLoading) return;

    if (!userId) {
      setProfile({ creatorId: null, contentTier: null, displayName: null });
      setLoading(false);
      return;
    }

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

      const { data, error: readError } = await supabase
        .from('creators')
        .select('id, content_tier, display_name')
        .eq('user_id', userId)
        .maybeSingle();

      if (cancelled) return;

      if (readError) {
        console.error('[useCreatorProfile] creators read failed', readError);
        setError('โหลดข้อมูล Creator ไม่สำเร็จ กรุณาลองใหม่');
        setLoading(false);
        return;
      }

      setProfile({
        creatorId: data?.id ? String(data.id) : null,
        contentTier: data?.content_tier ? String(data.content_tier) : null,
        displayName: data?.display_name ? String(data.display_name) : null,
      });
      setError(null);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [userId, userLoading]);

  return { ...profile, loading: userLoading || loading, error };
}
