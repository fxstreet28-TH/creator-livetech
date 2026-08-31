'use client';

/**
 * Everything /posts/[id] needs: the post's metadata, whether this viewer may
 * watch it, and the creator's plans if they may not.
 *
 * The two-source shape is forced by the live RLS. `feed_posts_public_read`
 * only exposes `access_level = 'public'` rows, so a locked post reads back as
 * NO ROW for an un-entitled viewer — indistinguishable from a deleted one.
 * `content-get-playback-url` runs as the service role and sees every row, so
 * its 403 body is what turns "no row" into "locked, and here is the title and
 * thumbnail". The full sequence:
 *
 *   1. read feed_posts. A row means the viewer can at least see the metadata.
 *   2. ask for playback:
 *        200 -> play
 *        403 has_access:false -> lock card, from the 403's own metadata
 *        401 -> not signed in; offer login
 *   3. no row in (1) AND no answer in (2) -> genuinely not found.
 *
 * Playback is requested on mount rather than on a tap, unlike the creator's
 * own preview. There the fetch is deferred because it increments view_count
 * and a creator should not inflate their own numbers; here a view IS the point
 * of the page, and deferring it would mean the viewer taps play only to find
 * out the post was locked all along.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';
import {
  fetchPlayback,
  fetchPublicPost,
  fetchSubscriptionPlans,
} from '@/lib/viewer/publicFeed';
import type {
  PlaybackResult,
  PublicPost,
  SubscriptionPlanSummary,
} from '@/lib/viewer/types';

export interface PublicPostResult {
  post: PublicPost | null;
  /** Resolved entitlement, or null while it is still in flight. */
  playback: PlaybackResult | null;
  /** The creator's active plans. Only loaded when the post is subscriber-locked. */
  plans: SubscriptionPlanSummary[];
  loading: boolean;
  /** Thai, renderable. Set only for a metadata read that failed outright. */
  error: string | null;
  /** Neither the table nor the playback function knows this post. */
  notFound: boolean;
  refresh: () => void;
}

export function usePublicPost(postId: string | null): PublicPostResult {
  const { user, loading: userLoading } = useDashboardUser();

  const [post, setPost] = useState<PublicPost | null>(null);
  const [playback, setPlayback] = useState<PlaybackResult | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  const userId = user?.id ?? null;

  // Waiting for the session to resolve before asking for playback: firing the
  // request while getSession() is still settling sends no Authorization header
  // and gets a 401, which would show a signed-in viewer a login prompt.
  useEffect(() => {
    if (!postId || userLoading) return;

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

      const meta = await fetchPublicPost(supabase, postId as string);
      if (cancelled) return;

      if (meta.error) {
        setError(meta.error);
        setLoading(false);
        return;
      }

      setPost(meta.post);
      setError(null);

      // No metadata AND no session means nothing can resolve this id: the
      // playback function would answer 401 for every post alike, so asking it
      // could only turn a 404 into a misleading "please log in".
      if (!meta.post && userId === null) {
        setNotFound(true);
        setPlayback(null);
        setLoading(false);
        return;
      }

      // A post whose encode has not finished has no manifest to ask for, and
      // the function answers 409 for it. The page says so from the metadata
      // instead of spending a round trip to be told.
      if (meta.post && meta.post.video_status !== 'ready') {
        setNotFound(false);
        setPlayback(null);
        setLoading(false);
        return;
      }

      const result = await fetchPlayback(supabase, postId as string);
      if (cancelled) return;

      setPlayback(result);
      setNotFound(
        !meta.post &&
          result.kind === 'error' &&
          (result.error.code === 'not_found' || result.error.code === 'not_published'),
      );

      // Plans only matter behind a subscriber wall, and only the denial says
      // which creator to ask about when RLS hid the post's own row.
      const creatorId = meta.post?.creator_id ?? null;
      if (result.kind === 'denied' && result.playback.access_level === 'subscribers' && creatorId) {
        const active = await fetchSubscriptionPlans(supabase, creatorId);
        if (!cancelled) setPlans(active);
      } else {
        setPlans([]);
      }

      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [postId, userId, userLoading, attempt]);

  return {
    post: postId ? post : null,
    playback: postId ? playback : null,
    plans,
    loading: postId ? loading : false,
    error: postId ? error : null,
    notFound: postId ? notFound : true,
    refresh,
  };
}
