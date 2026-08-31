'use client';

/**
 * The signed-in creator's own posts, newest first, for /creator/posts.
 *
 * Read straight from `feed_posts` with the browser client rather than through
 * an Edge Function: `feed_posts_creator_own_all` (FOR ALL, creator_id IN own
 * creators) plus the `authenticated` SELECT grant already scope the rows, and
 * a function in front of them would add a hop and a second place for the
 * filter to be wrong. Same reasoning as useWalletHistory.
 *
 * While any post is still encoding the list re-reads on a timer — see
 * ENCODING_POLL_MS for why this is not a Realtime subscription.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import {
  ENCODING_POLL_MS,
  ENCODING_POLL_TIMEOUT_MS,
  IN_PROGRESS_VIDEO_STATUSES,
} from '@/lib/creator/constants';
import { POST_COLUMNS, type CreatorPost } from '@/lib/creator/types';

/** Deep history is a later concern; 50 covers every creator at launch. */
const POST_LIMIT = 50;

export interface CreatorPostsResult {
  posts: CreatorPost[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function isEncoding(post: Pick<CreatorPost, 'video_status'>): boolean {
  return (
    post.video_status !== null &&
    (IN_PROGRESS_VIDEO_STATUSES as readonly string[]).includes(post.video_status)
  );
}

export function useCreatorPosts(creatorId: string | null): CreatorPostsResult {
  const [posts, setPosts] = useState<CreatorPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  /** When polling started, so it can stop rather than run forever. */
  const pollStartedAt = useRef<number | null>(null);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  // A signed-in user with no creator row is not an error — they see the
  // "apply to be a creator" state. That shape is derived at the return rather
  // than written into state, so this effect only ever talks to Supabase.
  useEffect(() => {
    if (!creatorId) return;

    let cancelled = false;

    async function load() {
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
        .from('feed_posts')
        .select(POST_COLUMNS)
        .eq('creator_id', creatorId)
        .order('created_at', { ascending: false })
        .limit(POST_LIMIT);

      if (cancelled) return;

      if (readError) {
        console.error('[useCreatorPosts] feed_posts read failed', readError);
        setError('โหลดโพสต์ไม่สำเร็จ กรุณาลองใหม่');
        setLoading(false);
        return;
      }

      setPosts((data ?? []) as unknown as CreatorPost[]);
      setError(null);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [creatorId, attempt]);

  // Poll while something is encoding, so the badge flips without a manual
  // reload when the Bunny webhook lands.
  const hasEncoding = posts.some(isEncoding);

  useEffect(() => {
    if (!hasEncoding) {
      pollStartedAt.current = null;
      return;
    }
    if (pollStartedAt.current === null) pollStartedAt.current = Date.now();

    const timer = setInterval(() => {
      const startedAt = pollStartedAt.current;
      if (startedAt !== null && Date.now() - startedAt > ENCODING_POLL_TIMEOUT_MS) {
        clearInterval(timer);
        return;
      }
      refresh();
    }, ENCODING_POLL_MS);

    return () => clearInterval(timer);
  }, [hasEncoding, refresh]);

  return {
    posts: creatorId ? posts : [],
    loading: creatorId ? loading : false,
    error: creatorId ? error : null,
    refresh,
  };
}
