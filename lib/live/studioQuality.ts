'use client';

/**
 * WHAT RUNG THE STUDIO STARTS ON, AND WHY IT KEPT FORGETTING.
 *
 * THE OBSERVED PROBLEM. Por's live_sessions rows read 1080p, 1080p, then 720p:
 * he picked the sharper rung, went live, came back a week later and published
 * the default without noticing. Nothing was broken — the form starts on
 * DEFAULT_QUALITY every time, by design, and a creator who picked something
 * else last month has no reminder that they did. The cost of that is exactly
 * the thing this PR is about: a shared chart at 720p, on a rung he had already
 * decided against, with no way to tell from the studio that anything was
 * different from last time.
 *
 * WHAT THIS FIXES AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It remembers the LAST RUNG A CREATOR ACTUALLY WENT LIVE AT, on this device,
 * and offers it back on the setup form. That is it. In particular:
 *
 *  - It never applies a rung the creator's TIER does not allow. The stored
 *    value is a preference, not an entitlement; `check_creator_can_golive`
 *    clamps regardless, and offering an option that will be clamped is a form
 *    that lies.
 *  - It never applies 1080p on a phone-sized viewport, because that option is
 *    not on offer there at all (see `desktopOnly`) and a select holding a value
 *    its own list does not contain renders blank.
 *  - IT IS NEVER SILENT. The rung is the billing line — see
 *    bunnyThbPerViewerMinute — and a bill that changed because a browser
 *    remembered something is a bill nobody agreed to. The form says, in one
 *    line, that this came from last time. A restored rung the creator does not
 *    want is one tap away from being changed, before anything is created.
 *
 * WRITTEN ON GO-LIVE, not on every keystroke of the dropdown. What is worth
 * remembering is a decision that was carried through, not one that was scrolled
 * past — and a creator who opens the form, changes the rung, then abandons the
 * page has not told us anything.
 *
 * localStorage directly rather than through getAuthStorage(), same reasoning
 * as lib/live/cameraOrientation: this decides what a form renders on its first
 * paint, an awaited read would show the wrong value and then change it, and a
 * device that loses it falls back to the behaviour every creator had before
 * this existed. Every access is wrapped — Safari in private mode throws rather
 * than returning null, and a go-live must not fail because a preference could
 * not be read.
 */

import { isBroadcastQuality } from './constants';
import type { BroadcastQuality } from './types';

const STORAGE_KEY = 'aurum.live.quality';

/** The rung this device last went live at, or null if it never has. */
export function recallStudioQuality(): BroadcastQuality | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isBroadcastQuality(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Remember a rung that a broadcast was actually created at. */
export function rememberStudioQuality(quality: BroadcastQuality): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, quality);
  } catch {
    // Quota, private mode, a WebView with storage disabled. The broadcast is
    // unaffected; the next one simply starts on the default again.
  }
}
