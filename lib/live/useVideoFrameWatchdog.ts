'use client';

/**
 * "The transport says it is fine and the picture is frozen."
 *
 * The failure that no connection state catches. hls.js is happily buffering,
 * or the room reports connected, and the decoder has stopped producing frames
 * — which on iOS is a real and recurring state, and the one a reboot fixes.
 * Nothing in either SDK reports it, because from their point of view nothing
 * has gone wrong: bytes are arriving.
 *
 * So the check is made against the only thing that cannot lie about whether a
 * viewer is seeing anything: whether a NEW FRAME has been presented.
 *
 * `requestVideoFrameCallback` answers that exactly, and it is used wherever it
 * exists (Safari 15.4+, Chrome). Where it does not, `currentTime` advancing is
 * the next best thing — weaker, because it can creep on a stalled decoder, but
 * it is the same signal a person uses when they say the video is stuck.
 *
 * WHAT IT MUST NOT DO IS FIRE ON A PAUSED VIDEO. A viewer who paused, or a
 * browser that refused autoplay, produces no frames for entirely correct
 * reasons, and tearing the player down underneath them would be a bug wearing
 * a watchdog's clothes.
 */

import { useEffect, useRef } from 'react';

/** No new frame for this long, while supposedly playing, is broken. */
const STALL_AFTER_MS = 10_000;
const CHECK_EVERY_MS = 1_000;

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

export interface UseVideoFrameWatchdogOptions {
  /**
   * How to find the element. A getter rather than a ref because the LiveKit
   * path does not own its <video> — the SDK creates it on track subscribe and
   * appends it to a container.
   */
  getVideo: () => HTMLVideoElement | null;
  /** Only true when the transport believes it is delivering. */
  active: boolean;
  /** Fired once per stall. Re-arms when frames resume. */
  onStall: (detail: Record<string, unknown>) => void;
}

export function useVideoFrameWatchdog({ getVideo, active, onStall }: UseVideoFrameWatchdogOptions) {
  const onStallRef = useRef(onStall);
  useEffect(() => {
    onStallRef.current = onStall;
  }, [onStall]);

  useEffect(() => {
    if (!active) return;

    let disposed = false;
    let lastFrameAt = Date.now();
    let lastTime = -1;
    let reported = false;
    let frameCallbackId: number | null = null;
    let watched: FrameCallbackVideo | null = null;

    const armFrameCallback = (video: FrameCallbackVideo) => {
      if (disposed || typeof video.requestVideoFrameCallback !== 'function') return;
      frameCallbackId = video.requestVideoFrameCallback(() => {
        if (disposed) return;
        lastFrameAt = Date.now();
        reported = false;
        armFrameCallback(video);
      });
    };

    const check = () => {
      const video = getVideo();
      if (!video) return;

      // The element can be replaced under us — a rebuild rung, or the LiveKit
      // SDK re-attaching a track — so the frame callback follows it.
      if (video !== watched) {
        watched = video as FrameCallbackVideo;
        lastFrameAt = Date.now();
        lastTime = -1;
        reported = false;
        armFrameCallback(watched);
      }

      // A paused or not-yet-started element is not a stalled one.
      if (video.paused || video.ended || video.readyState < 2) {
        lastFrameAt = Date.now();
        return;
      }

      // The fallback signal, for browsers with no frame callback.
      if (typeof watched.requestVideoFrameCallback !== 'function') {
        if (video.currentTime !== lastTime) {
          lastTime = video.currentTime;
          lastFrameAt = Date.now();
          reported = false;
        }
      }

      const stalledFor = Date.now() - lastFrameAt;
      if (stalledFor < STALL_AFTER_MS || reported) return;

      reported = true;
      onStallRef.current({
        stalled_ms: stalledFor,
        ready_state: video.readyState,
        current_time: Number(video.currentTime.toFixed(2)),
        has_frame_callback: typeof watched.requestVideoFrameCallback === 'function',
      });
    };

    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      if (frameCallbackId !== null && watched?.cancelVideoFrameCallback) {
        watched.cancelVideoFrameCallback(frameCallbackId);
      }
    };
  }, [active, getVideo]);
}
