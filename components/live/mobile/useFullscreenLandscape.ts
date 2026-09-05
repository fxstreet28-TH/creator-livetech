'use client';

/**
 * The ⤢ button's behaviour: make the video as big as the device will allow,
 * and turn it sideways where that is something a web page may ask for.
 *
 * TWO PLATFORMS, TWO OUTCOMES, AND THE DIFFERENCE IS NOT OURS TO FIX.
 *
 * On Android Chrome, `requestFullscreen()` followed by
 * `screen.orientation.lock('landscape')` does exactly what the button
 * promises: the browser chrome goes and the device rotates itself. The lock
 * only resolves at all while the document is fullscreen, which is why the two
 * calls are in that order and why the lock failing is not treated as the
 * fullscreen failing.
 *
 * On iOS Safari there is no Fullscreen API for an arbitrary element and no
 * Screen Orientation lock at all — `video.webkitEnterFullscreen()` exists but
 * hands the frame to the system player, which would take the chat, the gifts
 * and the composer off the screen. So there the honest answer is that the page
 * is ALREADY as full-bleed as it can be and the viewer rotates the handset
 * themselves; the caller says so rather than the button doing nothing.
 *
 * `supported` is what the caller branches on. It is resolved in an effect
 * rather than read during render because it is a browser capability, and
 * because reading it during render would differ between the server and the
 * client.
 */

import { useCallback, useEffect, useState } from 'react';

interface FullscreenLandscape {
  /** True while the document is in fullscreen because of this control. */
  active: boolean;
  /** False where the platform has no Fullscreen API — iOS Safari, notably. */
  supported: boolean;
  /** Enter, or leave if already in. Resolves once the browser has settled. */
  toggle: (element: HTMLElement | null) => Promise<void>;
}

/** Chrome/Safari both expose this; the older prefixed form is Safari desktop. */
type LegacyDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type LegacyElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

/** `lock`/`unlock` are not in lib.dom for every TS version. */
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape' | 'portrait') => Promise<void>;
  unlock?: () => void;
};

function fullscreenElement(): Element | null {
  const doc = document as LegacyDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

export function useFullscreenLandscape(): FullscreenLandscape {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const detect = () => {
      const probe = document.documentElement as LegacyElement;
      setSupported(
        typeof probe.requestFullscreen === 'function' ||
          typeof probe.webkitRequestFullscreen === 'function',
      );
    };
    detect();

    // The viewer can leave fullscreen with the system back gesture or Escape,
    // which never goes through `toggle`. Without this the button would go on
    // claiming the page was fullscreen after it had stopped being.
    const sync = () => setActive(fullscreenElement() !== null);
    sync();
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  const toggle = useCallback(async (element: HTMLElement | null) => {
    const doc = document as LegacyDocument;
    const orientation = screen?.orientation as LockableOrientation | undefined;

    if (fullscreenElement()) {
      // Unlock BEFORE exiting: an orientation lock is scoped to the fullscreen
      // session, and unlocking after it has ended is a no-op that leaves an
      // Android handset sideways on a page that is no longer landscape.
      try {
        orientation?.unlock?.();
      } catch {
        // Not every browser that has `orientation` has `unlock`.
      }
      try {
        await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      } catch (err) {
        console.error('[useFullscreenLandscape] exit failed', err);
      }
      return;
    }

    const target = (element ?? document.documentElement) as LegacyElement;
    try {
      await (target.requestFullscreen?.() ?? target.webkitRequestFullscreen?.());
    } catch (err) {
      // Refused (no user gesture, a permissions policy, an iOS webview). There
      // is nothing to lock to, so stop here.
      console.error('[useFullscreenLandscape] request failed', err);
      return;
    }

    try {
      await orientation?.lock?.('landscape');
    } catch {
      // Fullscreen without the rotation is still most of what was asked for —
      // iPadOS and desktop Chrome both land here — so this is not an error the
      // viewer needs to hear about.
    }
  }, []);

  return { active, supported, toggle };
}
