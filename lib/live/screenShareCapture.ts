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
): Promise<ScreenShareSession | null> {
  if (!isScreenShareSupported()) return null;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
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

  const settings = track.getSettings();
  console.info(
    `[screen] sharing ${settings.width ?? '?'}x${settings.height ?? '?'} @${settings.frameRate ?? '?'}fps` +
      (settings.displaySurface ? ` (${settings.displaySurface})` : ''),
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
