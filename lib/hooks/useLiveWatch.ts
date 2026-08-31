'use client';

/**
 * Everything /live/[sessionId] needs before it can render: the session's
 * metadata, who is broadcasting it, and either a LiveKit token or the reason
 * there is not one.
 *
 * The two-source shape is forced by RLS, the same way usePublicPost's is.
 * `live_sessions_public_active_read` exposes only `access_level = 'public'`
 * rows, and `live_sessions_subscriber_read` only adds the subscriber's own —
 * so a PPV session, and a subscribers session seen by a non-subscriber, read
 * back as NO ROW, indistinguishable from a session that does not exist.
 * `live-create-session` mode=join runs as the service role and sees every row,
 * so its refusal is what turns "no row" into "locked". The full sequence:
 *
 *   1. read live_sessions. A row means the viewer can at least see the
 *      metadata — and if it says 'ended' or 'cancelled', there is nothing to
 *      join and no token is asked for.
 *   2. ask to join:
 *        200                  -> watch
 *        403 access_denied    -> lock card
 *        409 not_active       -> the session ended between (1) and (2)
 *        404                  -> genuinely no such session
 *   3. resolve the creator, when (1) gave us a creator_id to resolve.
 *
 * Joining is requested on mount rather than on a tap: the join is what mints
 * the token, and a viewer who taps play only to be told they are not allowed
 * in has been made to wait for a refusal.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { fetchCreatorSummary } from '@/lib/viewer/publicFeed';
import type { CreatorSummary } from '@/lib/viewer/types';
import { fetchLiveSession, joinLiveSession, lockLevelFromMessage } from '@/lib/live/api';
import type { LiveSessionDetail } from '@/lib/live/types';

/**
 * What the page branches on. A discriminated union rather than
 * `{ data, error }` because "locked" and "ended" are successful, expected
 * answers that render their own screens — collapsing them into `error` is what
 * makes a paywall look like a crash.
 */
export type LiveJoinState =
  | { kind: 'pending' }
  | { kind: 'allowed'; wsUrl: string; token: string }
  | { kind: 'locked'; level: 'subscribers' | 'ppv' }
  | { kind: 'ended' }
  | { kind: 'cancelled' }
  | { kind: 'not_found' }
  /** Thai, renderable. */
  | { kind: 'error'; message: string };

export interface LiveWatchResult {
  session: LiveSessionDetail | null;
  creator: CreatorSummary | null;
  join: LiveJoinState;
  loading: boolean;
  refresh: () => void;
}

export function useLiveWatch(sessionId: string | null): LiveWatchResult {
  const [session, setSession] = useState<LiveSessionDetail | null>(null);
  const [creator, setCreator] = useState<CreatorSummary | null>(null);
  const [join, setJoin] = useState<LiveJoinState>({ kind: 'pending' });
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setJoin({ kind: 'pending' });

      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        if (!cancelled) {
          setJoin({ kind: 'error', message: 'ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง' });
          setLoading(false);
        }
        return;
      }

      const { session: row, error: readError } = await fetchLiveSession(supabase, sessionId!);
      if (cancelled) return;
      setSession(row);

      // The creator lookup runs alongside the join rather than before it: a
      // slow profile read must not delay the video by a round trip, and every
      // screen this hook feeds renders fine with an unnamed creator.
      if (row) {
        void fetchCreatorSummary(supabase, row.creator_id).then((summary) => {
          if (!cancelled) setCreator(summary);
        });
      }

      // A readable row that is already over answers the question by itself.
      // Asking to join would only spend a round trip to be told 409.
      if (row?.status === 'ended') {
        setJoin({ kind: 'ended' });
        setLoading(false);
        return;
      }
      if (row?.status === 'cancelled') {
        setJoin({ kind: 'cancelled' });
        setLoading(false);
        return;
      }

      const { data, error } = await joinLiveSession(supabase, { live_session_id: sessionId! });
      if (cancelled) return;

      if (data) {
        setJoin({ kind: 'allowed', wsUrl: data.ws_url, token: data.access_token });
        setLoading(false);
        return;
      }

      if (error?.code === 'access_denied') {
        setJoin({
          kind: 'locked',
          // The readable row is the better source when there is one; the 403's
          // English sentence is the fallback for the case RLS hid it, which is
          // exactly the case a lock card exists for.
          level:
            row?.access_level === 'ppv' || row?.access_level === 'subscribers'
              ? row.access_level
              : lockLevelFromMessage(error.detail),
        });
      } else if (error?.code === 'not_active') {
        setJoin({ kind: 'ended' });
      } else if (error?.status === 404) {
        setJoin({ kind: 'not_found' });
      } else {
        setJoin({
          kind: 'error',
          message: error?.message ?? readError ?? 'เข้าชมไลฟ์ไม่สำเร็จ กรุณาลองใหม่',
        });
      }
      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  return { session, creator, join, loading, refresh };
}
