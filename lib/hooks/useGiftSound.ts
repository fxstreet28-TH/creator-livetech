'use client';

/**
 * The creator's gift-chime preference, and the chime itself.
 *
 * MUTED BY DEFAULT and remembered per device. It is the creator's toggle
 * because the creator is the one who benefits: they are looking at their camera
 * rather than at the overlay, and a chime is how they know to say thank you. A
 * viewer already has the creator's audio and did not ask for a second source.
 *
 * `useSyncExternalStore` rather than a `useState` seeded in an effect.
 * localStorage does not exist on the server, so the value cannot be read during
 * render, and reading it in an effect to call setState is a cascading render.
 * This is the case that hook exists for, and it comes with a server snapshot
 * that matches what the muted markup already says.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  getGiftSoundServerSnapshot,
  getGiftSoundSnapshot,
  playGiftSound,
  setGiftSoundEnabled,
  subscribeGiftSound,
} from '@/components/live/gifts/GiftSounds';

export interface GiftSound {
  enabled: boolean;
  toggle: () => void;
  /** Plays the chime for a gift of this size. A no-op while muted. */
  play: (starsTotal: number) => void;
}

export function useGiftSound(): GiftSound {
  const enabled = useSyncExternalStore(
    subscribeGiftSound,
    getGiftSoundSnapshot,
    getGiftSoundServerSnapshot,
  );

  const toggle = useCallback(() => setGiftSoundEnabled(!enabled), [enabled]);
  const play = useCallback((starsTotal: number) => playGiftSound(starsTotal, enabled), [enabled]);

  return { enabled, toggle, play };
}
