'use client';

/**
 * The broadcasting studio's "I am still here".
 *
 * WHY IT EXISTS. Nothing else in the system can tell a creator who is
 * broadcasting from a creator who closed the tab an hour ago. A LiveKit room
 * outlives its publisher; an HLS playlist that stops growing looks exactly
 * like a stalled upload; and `live_sessions.status` was only ever written by
 * somebody pressing "จบไลฟ์". So sessions stayed 'live' forever — holding
 * their slot on the dashboard, spinning every viewer who opened them, and
 * leaving a LiveKit egress running and billing. Two were found open for 16h
 * and 0.8h.
 *
 * This is the evidence the fix is built on: a write every 20 seconds, which
 * `live-watchdog` reaps against 90 seconds later (see the migration).
 *
 * THREE THINGS IT DOES BEYOND THE TIMER, and each is a real failure mode:
 *
 *  1. IT BEATS ON WAKE. Browsers throttle timers in a backgrounded tab —
 *     Chrome to once a minute, and iOS often not at all — so a creator who
 *     switched apps for a moment would be reaped mid-broadcast. Coming back
 *     to visible fires a beat immediately rather than waiting for the next
 *     tick.
 *  2. IT STOPS WHEN THE SESSION IS GONE. `touch_live_heartbeat` returns NULL
 *     for a session that has already ended, and this reports that upward. A
 *     restored background tab must not resurrect a session the watchdog
 *     closed, and it must not keep an ended row's heartbeat fresh.
 *  3. IT FIRES THE BEACON. On `pagehide` — not `beforeunload`, which does not
 *     run on iOS at all and is unreliable on a killed tab — it posts a
 *     best-effort end request, so the ordinary "closed the tab" case is
 *     instant instead of 90 seconds late. The watchdog is what makes it
 *     correct; the beacon only makes it quick.
 */

import { useEffect, useRef } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { endLiveSessionBeacon, touchLiveHeartbeat } from '@/lib/live/api';
import { HEARTBEAT_INTERVAL_MS } from '@/lib/live/constants';

export interface UseLiveHeartbeatOptions {
  /** The session to beat for, or null when nothing is being broadcast. */
  sessionId: string | null;
  /**
   * The broadcaster's chat tally, read at the moment the beacon fires.
   *
   * A getter rather than a value: the beacon runs from an unload handler
   * registered once, and a captured number would be whatever it was when the
   * broadcast started.
   */
  getChatMessageCount?: () => number;
  /**
   * Called once when the backend says this session is no longer live —
   * somebody else ended it, or the watchdog did. The studio should stop
   * broadcasting and show the creator what happened.
   */
  onSessionClosed?: () => void;
}

export function useLiveHeartbeat({
  sessionId,
  getChatMessageCount,
  onSessionClosed,
}: UseLiveHeartbeatOptions): void {
  /**
   * The callbacks, through refs.
   *
   * The effect below must not re-run — and so must not tear down the
   * heartbeat and the unload listener — because a parent re-rendered with a
   * new inline function. Only `sessionId` may restart it.
   */
  const chatCountRef = useRef(getChatMessageCount);
  const closedRef = useRef(onSessionClosed);
  useEffect(() => {
    chatCountRef.current = getChatMessageCount;
    closedRef.current = onSessionClosed;
  }, [getChatMessageCount, onSessionClosed]);

  /**
   * The access token, cached.
   *
   * `pagehide` gives the page no time to await `auth.getSession()`, so the
   * token has to be sitting in a ref before it fires. Refreshed on every beat,
   * which also keeps it current across the hour-long refresh Supabase does
   * mid-broadcast.
   */
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    let supabase;
    try {
      supabase = getBrowserSupabase();
    } catch {
      return;
    }

    let stopped = false;
    // The beacon must fire at most once: `pagehide` can fire more than once
    // for one page (bfcache), and a second end request would be a wasted
    // round trip answered with `already_ended`.
    let beaconSent = false;

    const beat = async () => {
      if (stopped) return;

      const { data } = await supabase.auth.getSession();
      tokenRef.current = data.session?.access_token ?? null;

      const stillLive = await touchLiveHeartbeat(supabase, sessionId);
      if (stopped) return;

      if (!stillLive) {
        // Stop first: whatever the callback does, this hook must not keep
        // beating for a session the backend has closed.
        stopped = true;
        closedRef.current?.();
      }
    };

    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);

    // See (1) in the header — a throttled background tab is the common way a
    // live broadcaster would otherwise be mistaken for an absent one.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void beat();
    };
    document.addEventListener('visibilitychange', onVisible);

    const onPageHide = () => {
      if (beaconSent) return;
      beaconSent = true;
      stopped = true;
      const token = tokenRef.current;
      if (token) {
        endLiveSessionBeacon(sessionId, token, chatCountRef.current?.() ?? 0);
      }
    };
    // `pagehide` rather than `beforeunload`: Safari on iOS never fires
    // `beforeunload`, and it is the one browser this audience is mostly on.
    // `beforeunload` stays registered by the page itself, for its own "are you
    // sure" dialog — that is a different job.
    window.addEventListener('pagehide', onPageHide);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [sessionId]);
}
