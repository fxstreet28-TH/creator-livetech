'use client';

/**
 * "The phone came back." All four ways a browser says it, collapsed into one.
 *
 * THE FAILURE THIS EXISTS FOR. iOS Safari tears down active RTCPeerConnections
 * and suspends media decoding when a page goes to the background. That is
 * documented OS behaviour, not a fault — but it means a viewer who folds their
 * phone and unfolds it is holding a `closed` peer connection attached to a
 * <video> that will never show another frame. Nothing recovers it on its own,
 * and nothing in the viewer noticed, so the picture stayed black until the
 * page was reloaded by hand. What every live platform does here is not clever:
 * on foreground, if the session is not healthy, throw it away and subscribe
 * again. This hook is the "on foreground" half of that sentence.
 *
 * FOUR DOORS, BECAUSE NO ONE OF THEM CATCHES EVERYTHING:
 *
 *  - `visibilitychange` → visible. The tab switch, and the common case.
 *  - `pageshow`. A bfcache restore did NOT fire visibilitychange and did not
 *    re-run a single effect; iOS uses the bfcache constantly, so a player that
 *    watched only the first door missed the restore that matters most.
 *  - `focus`. A desktop alt-tab back to a window that was never hidden — the
 *    tab was visible the whole time, so neither of the above fired, and a
 *    60-second alt-tab is long enough for a connection to have died.
 *  - `online`. Wifi came back. Not a foreground at all, and it is the same
 *    question: is the session still delivering, and if not, rebuild it.
 *
 * WHY THE DEBOUNCE IS NOT OPTIONAL. Returning to Safari fires visibilitychange,
 * pageshow and focus inside a few milliseconds of each other. Three resubscribes
 * for one gesture is three handshakes racing to attach to the same <video>, and
 * the loser's teardown closes the winner's stream — the bug is a black screen
 * that only reproduces on the fix. One trailing call per burst, carrying every
 * source that fired, and the caller sees one event.
 *
 * DELIBERATELY NOT useWakeRecheck. That hook answers a different question and
 * answers it well for HLS: "was the tab away long enough to be worth checking,
 * and is it still broken 1.5 seconds later?" Its 20-second threshold and its
 * settle delay are right for a media element that often resumes by itself. A
 * WHEP peer connection never does, the threshold would ignore a 10-second fold,
 * and the delay would be 1.5 more seconds of black. This one has no threshold
 * and no delay: it reports the resume, and the caller decides.
 */

import { useEffect, useRef } from 'react';

/**
 * How long a burst is collected for before the caller hears about it.
 *
 * Long enough to swallow the visibility/pageshow/focus volley (a few ms in
 * practice), short enough to be invisible against a resubscribe that itself
 * takes several hundred milliseconds.
 */
const BURST_WINDOW_MS = 200;

/** Which door the browser came back through. 'tap' is the caller's own. */
export type ResumeTrigger = 'visibility' | 'pageshow' | 'focus' | 'online' | 'tap';

export interface ResumeEvent {
  /** The first door that fired in this burst. */
  trigger: ResumeTrigger;
  /** Every door that fired in it, in order. Diagnostic. */
  triggers: ResumeTrigger[];
  /**
   * How long the page was hidden, when it was hidden at all.
   *
   * Zero for a focus or an online event that arrived while the page was
   * visible throughout — which is a real resume and must not be filtered out
   * on the strength of a zero. Nothing here thresholds on this value; it is
   * for the console line.
   */
  hiddenMs: number;
  /** The page was restored from the bfcache — it never re-ran its effects. */
  persisted: boolean;
}

export interface UseResumeTriggersOptions {
  onResume: (event: ResumeEvent) => void;
  enabled?: boolean;
}

export function useResumeTriggers({ onResume, enabled = true }: UseResumeTriggersOptions): void {
  // Read through a ref so a parent passing an inline function cannot re-bind
  // four window listeners on every render.
  const onResumeRef = useRef(onResume);
  useEffect(() => {
    onResumeRef.current = onResume;
  }, [onResume]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    let hiddenSince: number | null =
      document.visibilityState === 'hidden' ? Date.now() : null;
    let burst: ResumeTrigger[] = [];
    let burstPersisted = false;
    let burstHiddenMs = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fire = (trigger: ResumeTrigger, persisted = false) => {
      // The hidden clock is read on the FIRST door of a burst and cleared
      // there: the second and third arrive milliseconds later and would each
      // report an absence of zero, hiding how long the viewer was really away.
      if (burst.length === 0) {
        burstHiddenMs = hiddenSince === null ? 0 : Date.now() - hiddenSince;
        burstPersisted = false;
      }
      hiddenSince = null;
      burst.push(trigger);
      burstPersisted ||= persisted;

      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const triggers = burst;
        burst = [];
        onResumeRef.current({
          trigger: triggers[0],
          triggers,
          hiddenMs: burstHiddenMs,
          persisted: burstPersisted,
        });
      }, BURST_WINDOW_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSince ??= Date.now();
        return;
      }
      fire('visibility');
    };
    // `persisted` is the whole point of listening to this one: a restored page
    // is holding a transport that has been dead for however long it was away,
    // and its effects did not re-run to find out.
    const onPageShow = (event: PageTransitionEvent) => fire('pageshow', event.persisted);
    const onFocus = () => fire('focus');
    const onOnline = () => fire('online');

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled]);
}
