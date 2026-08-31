'use client';

/**
 * The paginated viewer feed behind /discover, /c/[handle] and the dashboard's
 * "แนะนำสำหรับคุณ" strip.
 *
 * Pagination is a "โหลดเพิ่ม" button, not infinite scroll: it is one piece of
 * state instead of an observer plus a sentinel, it does not fight the browser
 * over scroll restoration when the viewer comes back from a post, and the
 * brief asks for the simpler one.
 *
 * `hasMore` is inferred from a full page rather than from a count(*): an exact
 * count costs a second aggregate on every page for the sole benefit of hiding
 * the button one tap earlier. The cost of being wrong is one "โหลดเพิ่ม" that
 * returns nothing and then disappears.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';
import {
  FEED_PAGE_SIZE,
  fetchFollowedCreatorIds,
  fetchPublicFeed,
  type FeedOrder,
} from '@/lib/viewer/publicFeed';
import type { PublicPost } from '@/lib/viewer/types';

export interface PublicFeedOptions {
  /** 'recent' (default) or 'popular' — view_count DESC, then recency. */
  order?: FeedOrder;
  /** Rows per page. Defaults to FEED_PAGE_SIZE. */
  pageSize?: number;
  /** Restrict to one creator — /c/[handle]. */
  creatorId?: string;
  /** Restrict to creators the signed-in user follows. */
  followingOnly?: boolean;
  /** Skip the read entirely — e.g. while the live tab is selected. */
  enabled?: boolean;
}

export interface PublicFeedResult {
  posts: PublicPost[];
  /** First page in flight. */
  loading: boolean;
  /** A "โหลดเพิ่ม" page in flight. */
  loadingMore: boolean;
  /** Thai, renderable. */
  error: string | null;
  /** The last page came back full, so there is probably another. */
  hasMore: boolean;
  /** True when followingOnly was asked for but nobody is signed in. */
  requiresAuth: boolean;
  loadMore: () => void;
  refresh: () => void;
}

const CLIENT_UNAVAILABLE = 'ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';

export function usePublicFeed(options: PublicFeedOptions = {}): PublicFeedResult {
  const {
    order = 'recent',
    pageSize = FEED_PAGE_SIZE,
    creatorId,
    followingOnly = false,
    enabled = true,
  } = options;

  const { user, loading: userLoading } = useDashboardUser();
  const userId = user?.id ?? null;

  const [posts, setPosts] = useState<PublicPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  /**
   * How many rows the next page skips. A ref, not state: it is written by the
   * loader and read by the next loader, and making it state would add a render
   * plus an effect dependency that re-runs the very load that set it.
   */
  const offset = useRef(0);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  /** Only the "กำลังติดตาม" tab needs a session; everything else is public. */
  const requiresAuth = followingOnly && !userLoading && userId === null;

  // Waiting on the session resolution before the first read, but only when the
  // query actually depends on it — a public feed must not block on auth.
  const blocked = !enabled || requiresAuth || (followingOnly && userLoading);

  // The blocked shape (no session for a following-only feed, or a disabled
  // tab) is derived at the return rather than written into state, which keeps
  // this effect a pure "talk to an external system" effect — the same pattern
  // as useCreatorPosts, and what stops the first render from cascading.
  useEffect(() => {
    if (blocked) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      offset.current = 0;

      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        if (!cancelled) {
          setError(CLIENT_UNAVAILABLE);
          setLoading(false);
        }
        return;
      }

      let creatorIds: string[] | undefined;
      if (followingOnly) {
        const follows = await fetchFollowedCreatorIds(supabase);
        if (cancelled) return;
        if (follows.error) {
          setError(follows.error);
          setLoading(false);
          return;
        }
        creatorIds = follows.creatorIds;
      }

      const { posts: page, error: readError } = await fetchPublicFeed(supabase, {
        limit: pageSize,
        offset: 0,
        order,
        creatorId,
        creatorIds,
      });

      if (cancelled) return;

      if (readError) {
        setError(readError);
        setLoading(false);
        return;
      }

      setPosts(page);
      setHasMore(page.length === pageSize);
      offset.current = page.length;
      setError(null);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [blocked, followingOnly, creatorId, order, pageSize, userId, attempt]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;

    let supabase;
    try {
      supabase = getBrowserSupabase();
    } catch {
      setError(CLIENT_UNAVAILABLE);
      return;
    }

    setLoadingMore(true);

    (async () => {
      let creatorIds: string[] | undefined;
      if (followingOnly) {
        const follows = await fetchFollowedCreatorIds(supabase);
        if (follows.error) {
          setError(follows.error);
          setLoadingMore(false);
          return;
        }
        creatorIds = follows.creatorIds;
      }

      const { posts: page, error: readError } = await fetchPublicFeed(supabase, {
        limit: pageSize,
        offset: offset.current,
        order,
        creatorId,
        creatorIds,
      });

      if (readError) {
        setError(readError);
        setLoadingMore(false);
        return;
      }

      // De-duplicate by id: `range()` is an offset window over a live table,
      // so a post published between two pages shifts everything down one and
      // would otherwise repeat a row — and a duplicate React key is a crash,
      // not a cosmetic bug.
      setPosts((current) => {
        const seen = new Set(current.map((post) => post.id));
        return [...current, ...page.filter((post) => !seen.has(post.id))];
      });
      setHasMore(page.length === pageSize);
      offset.current += page.length;
      setError(null);
      setLoadingMore(false);
    })();
  }, [loading, loadingMore, hasMore, followingOnly, creatorId, order, pageSize]);

  return {
    posts: blocked ? [] : posts,
    loading: blocked ? false : loading,
    loadingMore: blocked ? false : loadingMore,
    error: blocked ? null : error,
    hasMore: blocked ? false : hasMore,
    requiresAuth,
    loadMore,
    refresh,
  };
}
