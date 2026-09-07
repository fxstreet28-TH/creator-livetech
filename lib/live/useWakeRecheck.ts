'use client';

/**
 * Coming back to a tab that has been away.
 *
 * Safari suspends WebRTC and media decoding in a backgrounded tab, and it
 * frequently does not bring them back on its own — the viewer returns to a
 * frozen picture over a connection the SDK still calls healthy. The bfcache
 * makes it worse: a page restored from it did not reload, did not re-run its
 * effects, and is holding a transport that has been dead for twenty minutes.
 *
 * So both doors are watched: `visibilitychange` for a tab switch, and
 * `pageshow` for a bfcache restore, which does not fire the former.
 *
 * ONLY AFTER A REAL ABSENCE. Glancing away for two seconds must not tear a
 * working player down — a hidden tab is the normal state of a viewer reading a
 * notification, and mobile browsers fire visibilitychange for things as small
 * as the share sheet opening. Below the threshold this does nothing at all.
 */

import { useEffect, useRef } from 'react';

/** Hidden for longer than this is an absence worth re-checking after. */
const AWAY_THRESHOLD_MS = 20_000;

export interface UseWakeRecheckOptions {
  /**
   * Asked on return. True means the player is genuinely delivering — the
   * caller checks the transport AND that there is a live video track, because
   * "connected" is exactly the claim that survives a suspension.
   */
  isHealthy: () => boolean;
  /** Called when we came back from a real absence to a player that is not. */
  onWake: (detail: Record<string, unknown>) => void;
  enabled?: boolean;
}

export function useWakeRecheck({ isHealthy, onWake, enabled = true }: UseWakeRecheckOptions) {
  const isHealthyRef = useRef(isHealthy);
  const onWakeRef = useRef(onWake);
  useEffect(() => {
    isHealthyRef.current = isHealthy;
    onWakeRef.current = onWake;
  }, [isHealthy, onWake]);

  useEffect(() => {
    if (!enabled) return;

    let hiddenSince: number | null = document.visibilityState === 'hidden' ? Date.now() : null;

    const returned = (source: 'visibility' | 'pageshow', persisted: boolean) => {
      const awayMs = hiddenSince === null ? 0 : Date.now() - hiddenSince;
      hiddenSince = null;

      // A bfcache restore is an absence whatever the clock says: the page was
      // frozen wholesale, and the timestamp above may be from before it was.
      if (awayMs < AWAY_THRESHOLD_MS && !persisted) return;

      // Not immediately. A suspended media element needs a moment after the
      // tab is foregrounded to resume on its own, and firing the ladder in
      // that window would tear down a player that was about to recover by
      // itself — the cheapest possible fix, wasted.
      window.setTimeout(() => {
        if (isHealthyRef.current()) return;
        onWakeRef.current({ source, away_ms: awayMs, persisted });
      }, 1_500);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSince ??= Date.now();
        return;
      }
      returned('visibility', false);
    };

    const onPageShow = (event: PageTransitionEvent) => returned('pageshow', event.persisted);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [enabled]);
}
