'use client';

/**
 * Catch a phone that is running a bundle we stopped shipping.
 *
 * A device can hold a cached bundle across our deploys — an aggressive
 * intermediate cache, an iOS home-screen web app that has not been reopened in
 * a week — and then it is running old code against playback URLs and APIs that
 * have moved on. From the server it is invisible; from the viewer it is "the
 * video does not work on my phone"; and the only cure they know is rebooting
 * the device, which is how we got here.
 *
 * This is the ONE case where reloading the page is not a shot in the dark but
 * the actual fix, so it is checked separately from the recovery ladder and it
 * takes priority: reloading a stale bundle solves the problem, whereas
 * rebuilding a media element inside stale code cannot.
 *
 * IT ONLY EVER FIRES ON A DISAGREEMENT BETWEEN TWO REAL ANSWERS. No build id,
 * an unreachable route, an unparseable body, or either side reporting 'dev'
 * all mean "no information", and no information is never a reason to throw a
 * viewer's page away. That is also what makes this safe in the Capacitor
 * build, where /api/version does not exist at all — a static export has no
 * route handlers, the fetch fails, and nothing happens.
 *
 * Once per tab, per broadcast. A page that reloads itself on a poll is worse
 * than a stale one.
 */

import { useCallback, useEffect, useRef } from 'react';
import { RUNNING_BUILD_ID, type VersionResponse } from './buildId';
import { logViewerDiagnostic, type DeliveryPath, type HlsSource } from './viewerDiagnostics';

const POLL_MS = 60_000;

export interface UseStaleBuildGuardOptions {
  sessionId: string;
  delivery: DeliveryPath;
  /** Which server produced the playlist, on the 'hls' path. Recorded, not branched on. */
  source?: HlsSource;
  /**
   * Flips true when the player has failed to start. Triggers one extra check
   * outside the poll — a failure is the moment the answer matters most, and
   * waiting up to a minute for the next tick wastes the viewer's patience.
   */
  connectFailed: boolean;
  enabled?: boolean;
}

export function useStaleBuildGuard({
  sessionId,
  delivery,
  source,
  connectFailed,
  enabled = true,
}: UseStaleBuildGuardOptions): void {
  const checkingRef = useRef(false);

  const check = useCallback(async () => {
    // 'dev' means a local build, where there is nothing to be stale against.
    if (RUNNING_BUILD_ID === 'dev') return;
    if (checkingRef.current) return;
    checkingRef.current = true;

    try {
      // The cache-buster is not paranoia: the entire failure mode being
      // detected is something between here and the server holding an old
      // answer, and a cached /api/version would report exactly the staleness
      // it is supposed to reveal.
      const response = await fetch(`/api/version?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;

      const body = (await response.json()) as Partial<VersionResponse>;
      const serverBuild = typeof body.buildId === 'string' ? body.buildId : null;
      if (!serverBuild || serverBuild === 'dev' || serverBuild === RUNNING_BUILD_ID) return;

      const key = `live:build-reloaded:${sessionId}`;
      try {
        if (sessionStorage.getItem(key)) {
          logViewerDiagnostic({
            sessionId,
            delivery,
            source,
            step: 'stale_build',
            outcome: 'skipped',
            detail: { running: RUNNING_BUILD_ID, server: serverBuild },
          });
          return;
        }
        sessionStorage.setItem(key, '1');
      } catch {
        // No way to remember having reloaded means no way to stop reloading.
        return;
      }

      logViewerDiagnostic({
        sessionId,
        delivery,
        source,
        step: 'stale_build',
        outcome: 'detected',
        detail: { running: RUNNING_BUILD_ID, server: serverBuild },
      });

      const url = new URL(window.location.href);
      url.searchParams.set('r', String(Date.now()));
      window.location.replace(url.toString());
    } catch {
      // Offline, blocked, or a static export with no such route. All of them
      // are "no information" — see the header.
    } finally {
      checkingRef.current = false;
    }
  }, [sessionId, delivery, source]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void check(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, check]);

  useEffect(() => {
    if (!enabled || !connectFailed) return;
    void check();
  }, [enabled, connectFailed, check]);
}
