'use client';

/**
 * A single post of the signed-in creator's, for /creator/posts/[id].
 *
 * RLS decides visibility: `feed_posts_creator_own_all` matches only the
 * caller's own rows, so someone else's post id comes back as "no rows" rather
 * than as a forbidden row — which is why `notFound` is a distinct flag the
 * page redirects on, not an error string.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import {
  ENCODING_POLL_MS,
  ENCODING_POLL_TIMEOUT_MS,
  IN_PROGRESS_VIDEO_STATUSES,
} from '@/lib/creator/constants';
import { POST_COLUMNS, type CreatorPost } from '@/lib/creator/types';

export interface CreatorPostResult {
  post: CreatorPost | null;
  loading: boolean;
  /** Thai, renderable. */
  error: string | null;
  /** No row matched — either the id is wrong or it is not this creator's. */
  notFound: boolean;
  refresh: () => void;
}

export function useCreatorPost(postId: string | null): CreatorPostResult {
  const [post, setPost] = useState<CreatorPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const pollStartedAt = useRef<number | null>(null);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  // A missing id is "not found", derived at the return rather than written
  // into state so this effect stays a pure Supabase read.
  useEffect(() => {
    if (!postId) return;

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

      // maybeSingle, not single: RLS filtering a row out is an expected
      // outcome here, and single() turns it into a thrown PostgrestError.
      const { data, error: readError } = await supabase
        .from('feed_posts')
        .select(POST_COLUMNS)
        .eq('id', postId)
        .maybeSingle();

      if (cancelled) return;

      if (readError) {
        console.error('[useCreatorPost] feed_posts read failed', readError);
        setError('โหลดโพสต์ไม่สำเร็จ กรุณาลองใหม่');
        setLoading(false);
        return;
      }

      if (!data) {
        setPost(null);
        setNotFound(true);
        setLoading(false);
        return;
      }

      setPost(data as unknown as CreatorPost);
      setNotFound(false);
      setError(null);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [postId, attempt]);

  const encoding =
    post?.video_status !== null &&
    post?.video_status !== undefined &&
    (IN_PROGRESS_VIDEO_STATUSES as readonly string[]).includes(post.video_status);

  useEffect(() => {
    if (!encoding) {
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
  }, [encoding, refresh]);

  return {
    post: postId ? post : null,
    loading: postId ? loading : false,
    error: postId ? error : null,
    notFound: postId ? notFound : true,
    refresh,
  };
}
