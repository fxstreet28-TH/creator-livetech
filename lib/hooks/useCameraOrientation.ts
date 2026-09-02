'use client';

/**
 * The camera-orientation switches, as [value, setValue].
 *
 * A hook over the module store in lib/live/cameraOrientation rather than
 * component state, so the value is remembered across page loads without a
 * read-from-storage effect on mount. useSyncExternalStore handles the part
 * that is actually awkward: the server render and the hydration pass see the
 * defaults, and the stored value arrives right after, with no mismatch.
 *
 * Every consumer on the page reads the same store, so the setup screen and
 * the broadcast screen cannot disagree about which way round the picture is.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  getCameraOrientation,
  getServerCameraOrientation,
  setCameraOrientation,
  subscribeCameraOrientation,
  type CameraOrientation,
} from '@/lib/live/cameraOrientation';

export function useCameraOrientation(): [CameraOrientation, (next: CameraOrientation) => void] {
  const orientation = useSyncExternalStore(
    subscribeCameraOrientation,
    getCameraOrientation,
    getServerCameraOrientation,
  );

  const set = useCallback((next: CameraOrientation) => setCameraOrientation(next), []);

  return [orientation, set];
}
