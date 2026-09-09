'use client';

/**
 * Opening a screen, window or browser tab as a video source.
 *
 * A thin wrapper over `getDisplayMedia`, and deliberately nothing more. The
 * SOURCE PICKER IS THE BROWSER'S: Chrome, Edge, Firefox and Safari all put up
 * their own chooser listing every tab, window and display, with the OS-level
 * permission prompts that go with it. There is no way to enumerate those
 * sources from a page and no reason to want to — a picker of our own would be
 * a worse copy of one the browser already ships, and it could not offer a
 * screen at all.
 *
 * VIDEO ONLY. `audio: false` is not a default we inherited, it is a decision:
 * the broadcast is already publishing the microphone in the same room as the
 * speakers, so capturing the tab's audio would send the same sound twice —
 * once through the air and once through the tab — which is an echo, plus a
 * second stream for the encoder to mix for no gain. Screen audio is a separate
 * feature if it is ever wanted.
 *
 * WHERE IT IS NOT AVAILABLE, that is a state and not an error. `getDisplayMedia`
 * is absent on iOS Safari entirely (any browser on iOS, in fact — they are all
 * WebKit) and on macOS Safari below 13. `isScreenShareSupported` is what the
 * studio asks before it renders a button, so a creator on an iPhone never taps
 * something that can only fail.
 */

import { SCREEN_CAPTURE_MAX_FRAME_RATE, screenCaptureCapFor } from './compositeCanvas';
import { DEFAULT_QUALITY } from './constants';
import type { BroadcastQuality } from './types';

/** A screen capture that is running, and the one way to end it. */
export interface ScreenShareSession {
  /** Video only, one track. Hand it to the composite pipeline. */
  stream: MediaStream;
  /**
   * Stop the capture and release the source.
   *
   * Idempotent, and it does NOT call `onEnded` — see startScreenShare. A
   * caller that stops the share knows it stopped it.
   */
  stop: () => void;
}

/**
 * Can this browser share a screen at all?
 *
 * Read before rendering the toggle, not when it is pressed. The check is a
 * property test rather than a UA sniff because that is what actually decides
 * the outcome: the API is either there or it is not.
 */
export function isScreenShareSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * Put up the browser's picker and return what the creator chose.
 *
 * Resolves to `null` when they dismiss it, which is the common case and is not
 * a failure — a cancelled picker should leave the studio exactly as it was,
 * with no error and no state change. Anything else throws.
 *
 * `onEnded` fires when the capture ends WITHOUT the app asking: Chrome's
 * floating "Stop sharing" bar, a shared tab being closed, a window being
 * quit. It is the browser telling us the source is gone, and the studio's
 * answer is to fall back to the camera-only frame — never to reopen the
 * picker, which would be an app deciding on a creator's behalf to share their
 * screen again.
 */
export async function startScreenShare(
  onEnded?: () => void,
  /**
   * The rung the broadcast is publishing at. Decides the capture cap.
   *
   * Defaulted rather than required so the 720p behaviour is what a caller that
   * says nothing gets — the cap is a performance decision this module owns, and
   * a caller forgetting to pass it must not silently uncap a 4K monitor.
   */
  quality: BroadcastQuality = DEFAULT_QUALITY,
): Promise<ScreenShareSession | null> {
  if (!isScreenShareSupported()) return null;

  /**
   * How large a capture this rung can actually use.
   *
   * 1280x720 at 720p and 1920x1080 at 1080p — the slot the share is drawn into
   * scales with the frame, so the cap has to as well or a 1080p composite is a
   * 720p chart stretched across more pixels, which costs bitrate and buys
   * nothing. See screenCaptureCapFor for the cost side of that.
   */
  const cap = screenCaptureCapFor(quality);

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      /**
       * ==============================================================
       * CAPTURE SMALL. THE COMPOSITE CANNOT USE ANY MORE THAN THIS.
       * ==============================================================
       *
       * `getDisplayMedia({ video: true })` hands back the SOURCE's native
       * resolution: a 1440p monitor gives 2560x1440, a 4K one 3840x2160, a
       * Retina tab twice its CSS size. Those frames were then drawn into a
       * slot at most 720px across by `drawImage`, on the main thread, thirty
       * times a second — a downscale of eight million pixels per frame, in the
       * same thread that has to hand the encoder a finished frame every 33ms.
       * That is where the stutter came from, and it is why raising the bitrate
       * did nothing for it: no number of bits fixes a frame that was painted
       * late.
       *
       * Constrained, the browser does the same downscale in its own capture
       * path — off the main thread, in the compositor, once — and hands us
       * frames the size we were going to use anyway. The pixels a creator sees
       * on their monitor are unchanged; only what is CAPTURED shrinks.
       *
       * A MAXIMUM, not an exact size, on every axis. `max` is a constraint any
       * source can satisfy by staying under it, so a creator sharing a small
       * window or a 1366x768 laptop screen gets their own resolution untouched
       * and nothing is ever upscaled to meet a target.
       *
       * The framerate cap is the source's half of the same argument: a 60Hz
       * monitor captured at 60 is two decoded frames thrown away for every one
       * painted. 30 is the ceiling the composite could ever consume — it paints
       * at COMPOSITE_FRAME_RATE, which is lower still — and a ceiling on a
       * source is free where dropping frames later is not.
       */
      video: {
        width: { max: cap.width },
        height: { max: cap.height },
        frameRate: { max: SCREEN_CAPTURE_MAX_FRAME_RATE },
      },
      audio: false,
    });
  } catch (err) {
    // Dismissing the picker rejects, with a name that varies by browser:
    // Chrome says NotAllowedError, Firefox has been known to say AbortError.
    // Neither is something to report — the creator changed their mind.
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError' || name === 'AbortError' || name === 'NotFoundError') {
      console.info(`[screen] picker dismissed (${name || 'unknown'})`);
      return null;
    }
    console.error('[screen] getDisplayMedia failed', err);
    throw err;
  }

  const [track] = stream.getVideoTracks();
  if (!track) {
    // Should not happen with `video: true`, but a stream with no video track
    // would leave the composite drawing nothing and the toggle stuck on.
    stream.getTracks().forEach((t) => t.stop());
    console.error('[screen] no video track in the display stream');
    return null;
  }

  /**
   * Tell the encoder this is a DOCUMENT, not a person.
   *
   * The opposite hint to the camera's, for the opposite content: what a
   * creator shares here is a candlestick chart, a platform, a document — thin
   * lines, small text, high spatial detail — and 'detail' spends bits on
   * keeping that legible rather than on temporal smoothness. A blurred axis
   * label is a chart a viewer cannot read; a chart that updates a touch less
   * smoothly is still a chart.
   *
   * On the SOURCE track. It is drawn into the composite canvas rather than
   * published directly, so this tunes nothing on its own today — the canvas
   * carries its own hint. Set anyway because it is the honest description of
   * this track, and because it is what would take effect the day a share is
   * published as a second track rather than composited into one.
   */
  track.contentHint = 'detail';

  /**
   * DID THE CONSTRAINT ACTUALLY LAND? Ask, and if not, insist once.
   *
   * `getDisplayMedia` constraints are honoured by Chrome and Edge and have a
   * history of being ignored elsewhere — Firefox has shipped versions that
   * hand back the native surface whatever is asked for, and a browser is
   * within its rights to treat display capture as take-it-or-leave-it.
   * `applyConstraints` on the live track is the second ask, and where it works
   * it is the same downscale in the same place; where it does not, the
   * composite still draws the frame correctly, just at the old cost.
   *
   * Awaited so the size in the log line below is the FINAL one. It is a few
   * milliseconds inside a flow that has just waited on a human choosing a
   * window.
   */
  const native = track.getSettings();
  if ((native.width ?? 0) > cap.width || (native.height ?? 0) > cap.height) {
    try {
      await track.applyConstraints({
        width: { max: cap.width },
        height: { max: cap.height },
        frameRate: { max: SCREEN_CAPTURE_MAX_FRAME_RATE },
      });
    } catch (err) {
      console.warn('[screen] could not downscale the capture; compositing at source size', err);
    }
  }

  const settings = track.getSettings();
  /**
   * The one line that answers "what is the composite actually drawing?".
   *
   * Both numbers, not just the final one: a creator on a 4K monitor whose
   * browser ignored the cap and one on a 1366x768 laptop that was never over
   * it both end up with a single resolution in a log, and only the pair says
   * which of those happened. This is what confirms the fix on the machine
   * where the stutter was reported, rather than on the one it was fixed on.
   */
  const capped =
    native.width !== settings.width || native.height !== settings.height
      ? ` (capped from ${native.width ?? '?'}x${native.height ?? '?'})`
      : '';
  console.info(
    `[screen] sharing ${settings.width ?? '?'}x${settings.height ?? '?'} @${settings.frameRate ?? '?'}fps` +
      (settings.displaySurface ? ` (${settings.displaySurface})` : '') +
      capped +
      ` | cap ${cap.width}x${cap.height} for ${quality}`,
  );

  /**
   * One teardown, at most once.
   *
   * The `ended` event and `stop()` are two doors into the same room and the
   * flag is what keeps them from both walking through it: `stop()` on a track
   * does NOT fire `ended` (that event means "the source went away", not "the
   * track was stopped"), so without the guard a browser that decided otherwise
   * would run the studio's fallback twice.
   */
  let finished = false;

  const onTrackEnded = () => {
    if (finished) return;
    finished = true;
    track.removeEventListener('ended', onTrackEnded);
    console.info('[screen] source ended by the browser — falling back to camera only');
    onEnded?.();
  };

  track.addEventListener('ended', onTrackEnded);

  return {
    stream,
    stop: () => {
      if (finished) return;
      finished = true;
      track.removeEventListener('ended', onTrackEnded);
      stream.getTracks().forEach((t) => t.stop());
      console.info('[screen] stopped by the studio');
    },
  };
}
