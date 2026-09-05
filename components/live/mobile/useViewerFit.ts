'use client';

/**
 * The viewer's choice of how the video fills the phone screen, remembered.
 *
 * DEFAULT IS COVER, AND THERE IS NO AUTOMATIC FALLBACK. A full-bleed video is
 * the point of this layout, and a stream that letterboxes itself because the
 * creator happened to broadcast 16:9 reads as broken rather than as
 * considerate — TikTok, which this is modelled on, crops. What the sides lose,
 * a viewer who wants them back gets from the toggle, which is a decision they
 * make once and keep.
 *
 * localStorage rather than a database column: it is a per-device viewing
 * preference, like a volume level, and it should follow the phone rather than
 * the account. Every access is guarded — Safari in private mode throws on
 * `localStorage` access itself, not just on write, and a live page must not
 * fail to render because of a preference.
 */

import { useCallback, useEffect, useState } from 'react';

export type VideoFit = 'cover' | 'contain';

export const VIEWER_FIT_STORAGE_KEY = 'aurum:viewer:fit';

function readStoredFit(): VideoFit | null {
  try {
    const raw = window.localStorage.getItem(VIEWER_FIT_STORAGE_KEY);
    return raw === 'cover' || raw === 'contain' ? raw : null;
  } catch {
    return null;
  }
}

export function useViewerFit(): { fit: VideoFit; toggleFit: () => void } {
  /**
   * 'cover' on the first render, whatever is stored.
   *
   * Reading localStorage during render would be a server/client mismatch, and
   * reading it in a lazy initialiser is the same problem — this component is
   * rendered on the server too. So the default paints, and the stored value
   * arrives one effect later. The visible cost is a frame of `cover` for
   * someone who chose `contain`, which is the right direction to be wrong in:
   * `cover` is what the layout is designed around.
   */
  const [fit, setFit] = useState<VideoFit>('cover');

  useEffect(() => {
    // Through a named function rather than a bare `setFit(...)` in the effect
    // body: the same shape every other subscribe-and-adopt effect in this repo
    // uses, and what the cascading-render lint rule is looking for.
    const restore = () => {
      const stored = readStoredFit();
      setFit(stored ?? 'cover');
    };
    restore();
  }, []);

  const toggleFit = useCallback(() => {
    setFit((current) => {
      const next = current === 'cover' ? 'contain' : 'cover';
      try {
        window.localStorage.setItem(VIEWER_FIT_STORAGE_KEY, next);
      } catch {
        // A refused write costs the viewer the memory of this choice and
        // nothing else; the toggle still works for this session.
      }
      return next;
    });
  }, []);

  return { fit, toggleFit };
}
