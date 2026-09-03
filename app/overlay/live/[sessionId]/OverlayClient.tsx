'use client';

/**
 * The OBS browser source: gifts on a transparent canvas, and nothing else.
 *
 * No chrome, no header, no video, no controls — OBS composites this OVER the
 * creator's own scene, so anything that is not a gift is something covering
 * their camera. When no gift is playing the page is empty and fully
 * transparent.
 *
 * HOW IT AUTHENTICATES
 *
 * A browser source cannot sign in. The URL carries `?key=`, a per-creator
 * overlay key, and this page exchanges it once for a 12-hour JWT scoped to the
 * creator's own user id. The channel it then joins is the ORDINARY private
 * `live:<session_id>` topic under the ordinary `realtime.messages` policies —
 * the token simply makes this page the creator, and the creator is always
 * allowed into their own session. There is no overlay-shaped hole in the
 * entitlement rules.
 *
 * THE KEY IS REMOVED FROM THE URL AS SOON AS IT IS READ
 *
 * `history.replaceState` strips it before the first paint completes, so it is
 * not in the address bar of a creator who opens the URL in a real browser to
 * check it, not in a screenshot of that window, and not in any `document.URL`
 * a later script could read. It is held in a ref, never in state — state ends
 * up in React DevTools and in the DOM of an error overlay.
 */

import { useEffect, useMemo, useState } from 'react';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { useLiveChannel } from '@/lib/hooks/useLiveChannel';
import { GiftOverlay } from '@/components/live/gifts/GiftOverlay';

/**
 * Inset from the bottom-left corner, in px.
 *
 * 48 rather than the 12 the in-app overlay uses: an OBS canvas is 1920x1080
 * and its edges are where the streamer's own frame, webcam border and alert
 * boxes live. A tray flush to the corner of a 1080p scene reads as a mistake.
 */
const OBS_TRAY_INSET = 48;

type Phase =
  | { kind: 'connecting' }
  | { kind: 'ready'; token: string; userId: string }
  | { kind: 'denied' }
  | { kind: 'unconfigured' }
  | { kind: 'error' };

interface TokenResponse {
  access_token: string;
  expires_at: string;
  session_id: string;
}

/** Decode the `sub` of a JWT, without verifying it. */
function subjectOf(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    // base64url -> base64, and the padding atob needs.
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(
      atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')),
    ) as { sub?: unknown };
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Exchange the key for a token. A module-level async function, not a method on
 * the component, and that is what keeps the effect below honest: the component
 * only ever calls `setPhase` with something this returned, so there is no
 * synchronous state write in an effect body and no branch that can set state
 * before the request it is reporting on has happened.
 *
 * A missing key is not special-cased into an early return — it is sent as an
 * empty string and refused by the server with the same 403 as a wrong one.
 * One code path, and the answer comes from the only thing entitled to give it.
 */
async function exchangeOverlayToken(
  sessionId: string,
  overlayKey: string,
  signal: AbortSignal,
): Promise<Phase> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { kind: 'error' };

  try {
    // A plain fetch rather than supabase.functions.invoke: the function is
    // deployed with verify_jwt off precisely because the caller has no JWT, and
    // building a client just to post two fields would be a client with an
    // identity this page is not entitled to yet.
    const response = await fetch(`${url}/functions/v1/live-overlay-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ session_id: sessionId, overlay_key: overlayKey }),
      signal,
    });

    if (response.status === 403) return { kind: 'denied' };
    if (response.status === 503) return { kind: 'unconfigured' };
    if (!response.ok) return { kind: 'error' };

    const body = (await response.json()) as TokenResponse;
    const userId = subjectOf(body.access_token);
    if (!body.access_token || !userId) return { kind: 'error' };

    return { kind: 'ready', token: body.access_token, userId };
  } catch {
    // OBS starts its browser source before the machine's network is
    // necessarily up. Retryable, not a dead end.
    return { kind: 'error' };
  }
}

export function OverlayClient({ sessionId }: { sessionId: string }) {
  /**
   * Starts at 'connecting' rather than an 'idle' the first effect flips.
   *
   * There is no state before connecting — the page has one job and begins it on
   * mount — so an idle-then-connecting pair would be a cascading render to
   * express something the initial value can just say.
   */
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);

  /** The page paints on a transparent canvas; OBS composites what is left. */
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('aurum-overlay-transparent');
    return () => root.classList.remove('aurum-overlay-transparent');
  }, []);

  useEffect(() => {
    /**
     * The key, read from the URL and removed from it in the same breath.
     *
     * Stripping it before the first paint completes keeps it out of the address
     * bar of a creator who opens the URL in a real browser to check it, out of
     * a screenshot of that window, and out of any `document.URL` a later script
     * could read. It is never put in state: state ends up in React DevTools and
     * in the DOM of a Next.js error overlay.
     */
    const params = new URLSearchParams(window.location.search);
    const key = params.get('key') ?? '';

    if (key !== '') {
      params.delete('key');
      const query = params.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${query ? `?${query}` : ''}`,
      );
    }

    const controller = new AbortController();
    let cancelled = false;

    void exchangeOverlayToken(sessionId, key, controller.signal).then((next) => {
      if (!cancelled) setPhase(next);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId, attempt]);

  /**
   * Retry while the exchange is failing for a reason that could change.
   *
   * A denied key and an unconfigured project cannot fix themselves, so those two
   * stop — retrying a wrong key every fifteen seconds for an eight-hour
   * broadcast is a log full of 403s and nothing else. A network error can, and
   * OBS routinely starts its sources before the machine has a network.
   */
  useEffect(() => {
    if (phase.kind !== 'error') return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), 15_000);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  /**
   * A client built around the minted token.
   *
   * Its own instance, with `persistSession: false`: writing this token into the
   * storage the app's normal client reads would leave a creator-scoped session
   * behind on whatever machine OBS runs on.
   */
  const client: SupabaseClient | null = useMemo(() => {
    if (phase.kind !== 'ready') return null;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return null;

    return createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${phase.token}` } },
    });
  }, [phase]);

  const channel = useLiveChannel({
    sessionId: phase.kind === 'ready' ? sessionId : null,
    userId: phase.kind === 'ready' ? phase.userId : null,
    displayName: 'overlay',
    // Marks this presence entry as the creator's, so the OBS source is not
    // counted as a member of its own audience — the viewer count is what the
    // session's cost estimate is built from.
    isCreator: true,
    creatorUserId: phase.kind === 'ready' ? phase.userId : null,
    accessToken: phase.kind === 'ready' ? phase.token : undefined,
    client,
  });

  return (
    <main className="aurum-overlay-root">
      <GiftOverlay
        latestGift={channel.latestGift}
        resetKey={sessionId}
        inset={OBS_TRAY_INSET}
      />

      {/*
        Diagnostics, and only for the two states a person has to act on.
        Everything else — connecting, connected, idle — renders NOTHING, because
        anything drawn here is drawn over the creator's broadcast. A "connected"
        badge would be live on air for eight hours.
      */}
      {(phase.kind === 'denied' || phase.kind === 'unconfigured') && (
        <p className="aurum-overlay-notice">
          {phase.kind === 'denied'
            ? 'ลิงก์ overlay ไม่ถูกต้องหรือหมดอายุ — สร้างลิงก์ใหม่ที่หน้าตั้งค่า'
            : 'ระบบ overlay ยังไม่ได้ตั้งค่า — ติดต่อทีมงาน'}
        </p>
      )}
    </main>
  );
}
