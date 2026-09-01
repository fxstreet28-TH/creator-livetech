'use client';

/**
 * Everything /live/[sessionId] needs before it can render: the session's
 * metadata, who is broadcasting it, and either a way to watch or the reason
 * there is not one.
 *
 * The two-source shape is forced by RLS, the same way usePublicPost's is.
 * `live_sessions_public_active_read` exposes only `access_level = 'public'`
 * rows, and `live_sessions_subscriber_read` only adds the subscriber's own —
 * so a PPV session, and a subscribers session seen by a non-subscriber, read
 * back as NO ROW, indistinguishable from a session that does not exist.
 * `live-get-playback-url` runs as the service role and sees every row, so its
 * refusal is what turns "no row" into "locked". The full sequence:
 *
 *   1. read live_sessions. A row means the viewer can at least see the
 *      metadata — and if it says 'ended' or 'cancelled', there is nothing to
 *      watch and no URL is asked for.
 *   2. ask for a playback URL:
 *        200                     -> watch (LL-HLS, or LiveKit for a session
 *                                   with no Bunny stream)
 *        403 access_denied       -> lock card
 *        409 not_active          -> the session ended between (1) and (2)
 *        503 platform_unavailable-> the budget kill switch
 *        404                     -> genuinely no such session
 *   3. resolve the creator, when (1) gave us a creator_id to resolve.
 *
 * Asked for on mount rather than on a tap: this call is what decides
 * entitlement, and a viewer who taps play only to be told they are not allowed
 * in has been made to wait for a refusal.
 *
 * TWO THINGS RUN ON TIMERS, and both are new to the LL-HLS design:
 *
 *  - THE URL EXPIRES. A playback URL is minted with a one-hour TTL and a
 *    60-minute broadcast is an explicit requirement, so it is refreshed. A
 *    LiveKit viewer token was minted once and the room outlived it.
 *  - THE END OF THE BROADCAST HAS TO BE NOTICED. A LiveKit viewer was told:
 *    the room closed under them and the SDK fired Disconnected. An HLS viewer
 *    is told nothing — the playlist simply stops growing, which looks
 *    identical to a creator whose upload stalled — so the session's status is
 *    polled instead. Without this a viewer sits on a frozen last frame after
 *    the creator has pressed "จบไลฟ์".
 */

import { useCallback, useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { fetchCreatorSummary } from '@/lib/viewer/publicFeed';
import type { CreatorSummary } from '@/lib/viewer/types';
import { fetchLivePlayback, fetchLiveSession, lockLevelFromMessage } from '@/lib/live/api';
import { LIVE_STATUS_POLL_MS, PLAYBACK_REFRESH_MS } from '@/lib/live/constants';
import type { LatencyMode, LiveSessionDetail } from '@/lib/live/types';

/**
 * What the page branches on. A discriminated union rather than
 * `{ data, error }` because "locked" and "ended" are successful, expected
 * answers that render their own screens — collapsing them into `error` is what
 * makes a paywall look like a crash.
 */
export type LiveWatchState =
  | { kind: 'pending' }
  | {
      kind: 'hls';
      playbackUrl: string;
      latencyMode: LatencyMode;
      creatorUserId: string | null;
    }
  | {
      kind: 'livekit';
      wsUrl: string;
      token: string;
      creatorUserId: string | null;
    }
  | { kind: 'locked'; level: 'subscribers' | 'ppv' }
  | { kind: 'ended' }
  | { kind: 'cancelled' }
  | { kind: 'not_found' }
  /** Thai, renderable. */
  | { kind: 'error'; message: string };

export interface LiveWatchResult {
  session: LiveSessionDetail | null;
  creator: CreatorSummary | null;
  watch: LiveWatchState;
  loading: boolean;
  refresh: () => void;
}

export function useLiveWatch(sessionId: string | null): LiveWatchResult {
  const [session, setSession] = useState<LiveSessionDetail | null>(null);
  const [creator, setCreator] = useState<CreatorSummary | null>(null);
  const [watch, setWatch] = useState<LiveWatchState>({ kind: 'pending' });
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setWatch({ kind: 'pending' });

      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        if (!cancelled) {
          setWatch({ kind: 'error', message: 'ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง' });
          setLoading(false);
        }
        return;
      }

      const { session: row, error: readError } = await fetchLiveSession(supabase, sessionId!);
      if (cancelled) return;
      setSession(row);

      // The creator lookup runs alongside the playback call rather than before
      // it: a slow profile read must not delay the video by a round trip, and
      // every screen this hook feeds renders fine with an unnamed creator.
      if (row) {
        void fetchCreatorSummary(supabase, row.creator_id).then((summary) => {
          if (!cancelled) setCreator(summary);
        });
      }

      // A readable row that is already over answers the question by itself.
      // Asking for a URL would only spend a round trip to be told 409.
      if (row?.status === 'ended') {
        setWatch({ kind: 'ended' });
        setLoading(false);
        return;
      }
      if (row?.status === 'cancelled') {
        setWatch({ kind: 'cancelled' });
        setLoading(false);
        return;
      }

      const { data, error } = await fetchLivePlayback(supabase, sessionId!);
      if (cancelled) return;

      if (data) {
        setWatch(
          data.delivery === 'llhls'
            ? {
                kind: 'hls',
                playbackUrl: data.playback_url,
                latencyMode: data.latency_mode,
                creatorUserId: data.creator_user_id,
              }
            : {
                kind: 'livekit',
                wsUrl: data.ws_url,
                token: data.access_token,
                creatorUserId: data.creator_user_id,
              },
        );
        setLoading(false);
        return;
      }

      if (error?.code === 'access_denied') {
        setWatch({
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
        setWatch({ kind: 'ended' });
      } else if (error?.status === 404) {
        setWatch({ kind: 'not_found' });
      } else {
        setWatch({
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

  /**
   * Re-mint the playback URL before the current one lapses.
   *
   * A full `refresh()` would tear the player down and show a spinner; this
   * runs the same load path, and because the new URL is a new prop the player
   * re-attaches to it in place. Only armed once something is actually playing
   * — there is nothing to keep alive on a lock card.
   */
  useEffect(() => {
    if (watch.kind !== 'hls' && watch.kind !== 'livekit') return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), PLAYBACK_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [watch.kind, attempt]);

  /**
   * Notice when the broadcast is over.
   *
   * A poll rather than a subscription because `live_sessions` is not in the
   * `supabase_realtime` publication (only `stars_wallet` is), and adding it
   * would put every column of every session on a public channel to solve one
   * boolean. Read straight off the row rather than through the playback
   * function: this runs for the length of the broadcast on every viewer's
   * device, and it should be the cheapest query that answers the question.
   */
  useEffect(() => {
    if (watch.kind !== 'hls' && watch.kind !== 'livekit') return;
    if (!sessionId) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        return;
      }

      const { session: row } = await fetchLiveSession(supabase, sessionId);
      if (cancelled || !row) return;
      if (row.status === 'ended' || row.ended_at !== null) {
        setSession(row);
        setWatch({ kind: 'ended' });
      } else if (row.status === 'cancelled') {
        setSession(row);
        setWatch({ kind: 'cancelled' });
      }
    }, LIVE_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [watch.kind, sessionId]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  return { session, creator, watch, loading, refresh };
}
