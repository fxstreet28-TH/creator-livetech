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

import {
  SCREEN_CAPTURE_MAX_FRAME_RATE,
  screenCaptureCapFor,
  screenCapturePlanFor,
} from './compositeCanvas';
import { DEFAULT_QUALITY } from './constants';
import type { BroadcastQuality } from './types';

/**
 * ==========================================================================
 * THE CAPTURE SIZE IS DECIDED ONCE, IN THE FIRST SECONDS, AND NEVER AGAIN.
 * ==========================================================================
 *
 * WHAT THIS REPLACES, AND WHY. PR #68 measured the paint budget six seconds
 * into a share AND again on every layout change, and called `applyConstraints`
 * on the live display track whenever the p95 crossed 80%. Every part of that
 * is defensible in isolation and the combination is what Por recorded: tap a
 * layout button, the picture goes black for two or three seconds, and when it
 * comes back it does not move again.
 *
 * `applyConstraints` on a live display capture is not a cheap setter. Chrome
 * tears the capturer down and builds a new one at the new size: frames stop
 * arriving for a second or more — that is the black — and on a WINDOW capture
 * (which is what Por was sharing) it has been observed to end the track
 * outright. Whatever else was true, doing that in response to a LAYOUT TAP
 * meant a creator rearranging their frame was reconfiguring their capture
 * hardware, several times in a row, mid-broadcast.
 *
 * So the decision moves to the only place it can be made safely: the first
 * seconds of the share, before the creator has touched anything, at most once,
 * with no path back into it afterwards. A layout change cannot reach the track
 * any more because nothing outside this module can — `capTo1080` is gone from
 * the session's surface, and the session's own decision is spent by the time
 * the first layout button is legible.
 */

/**
 * A share above this is a candidate for the cap; at or below it, nothing is
 * ever asked of the track. 1920x1080 — see SCREEN_CAPTURE_MAX_* .
 */
const NATIVE_IS_LARGE = screenCaptureCapFor();

/**
 * How much of the frame budget the paint may use before the capture is capped.
 *
 * 0.8 rather than 1.0: a p95 AT the budget is a composite with no headroom,
 * and the machine it is running on has a browser, a chart and an encoder on it
 * too. Moved here from the studio, where it used to be read by the six-second
 * re-judge this replaces — the threshold and the one thing that acts on it
 * belong in the same file.
 */
export const PAINT_BUDGET_LIMIT = 0.8;

/**
 * How long the decision window stays open. Two seconds of real paint.
 *
 * Long enough for the percentiles to mean something — the first paints after
 * a share mounts include the canvas resize and the screen element's first
 * decodes and are several times the steady-state cost — and short enough that
 * it closes before a creator has finished reading the layout row. That second
 * property is the load-bearing one: a decision that can still fire while the
 * creator is tapping is the bug this replaces.
 */
const DECISION_WINDOW_MS = 2_000;

/**
 * Below this many logical cores, a larger-than-1080p surface is capped without
 * waiting to measure anything.
 *
 * `hardwareConcurrency` is a crude proxy for "can this machine crop and paint
 * a 4K frame in 41.7ms while encoding one", and crude is the right amount of
 * precision for a decision that has to be made before there is anything to
 * measure. 8 is where consumer laptops that can do it and ones that cannot
 * broadly divide, and being wrong in either direction costs sharpness rather
 * than a broadcast.
 */
const CHEAP_MACHINE_CORES = 8;

/** What the composite is currently costing, for the one deferred decision. */
export interface PaintBudgetReading {
  /** The 95th percentile paint, in ms. */
  p95: number;
  /** 1000 / the rate the composite paints at. 41.7ms at 24fps. */
  budgetMs: number;
}

export interface ScreenShareOptions {
  /**
   * Read the composite's real paint cost. Supplied by the studio.
   *
   * A callback rather than a number because the answer does not exist yet when
   * a share starts — see DECISION_WINDOW_MS — and rather than an import
   * because this module has no business knowing which pipeline is painting.
   * Return null when there is nothing to read; the share then keeps whatever
   * the heuristic decided and closes the window.
   */
  measurePaint?: () => PaintBudgetReading | null;
  /**
   * Called immediately BEFORE the one possible `applyConstraints`.
   *
   * The studio wires this to `holdSecondSlot`, so the top slot goes black for
   * the reconfigure and comes back on the source's own `resize` rather than
   * painting from a decoder that is mid-teardown. See cameraFilters.
   */
  onReconfigure?: () => void;
}

/**
 * Is a surface of this size, on a machine with this many cores, worth capping
 * before anything has been measured?
 *
 * Pure, and exported, because it is the half of the decision that can be
 * checked without a browser, a monitor or a stopwatch.
 */
export function shouldCapOnSight(
  native: { width: number; height: number },
  hardwareConcurrency: number | undefined,
): boolean {
  const larger = native.width > NATIVE_IS_LARGE.width || native.height > NATIVE_IS_LARGE.height;
  if (!larger) return false;
  // An unknown core count is treated as capable. A browser that will not say
  // is not evidence of a slow machine, and capping on silence would throw away
  // the native capture on every browser that does not implement the property.
  if (typeof hardwareConcurrency !== 'number' || !Number.isFinite(hardwareConcurrency)) {
    return false;
  }
  return hardwareConcurrency < CHEAP_MACHINE_CORES;
}

/** Is the measured paint over the share of the budget a capture may use? */
export function isOverPaintBudget(reading: PaintBudgetReading | null): boolean {
  if (!reading || !(reading.budgetMs > 0) || !(reading.p95 > 0)) return false;
  return reading.p95 / reading.budgetMs > PAINT_BUDGET_LIMIT;
}

/** A screen capture that is running, and the one way to end it. */
export interface ScreenShareSession {
  /** Video only, one track. Hand it to the composite pipeline. */
  stream: MediaStream;
  /**
   * What the creator actually picked: a tab, a window, or a whole monitor.
   *
   * `track.getSettings().displaySurface` normalised — Chrome says 'browser'
   * for a tab, which is not a word any creator or any log reader uses. Null
   * where the browser does not report it.
   *
   * It is on the session rather than only in a log line because it is the one
   * fact about a share that explains a whole class of report: a WINDOW capture
   * carries the browser's own tab strip and address bar into the broadcast and
   * is the surface `applyConstraints` is least reliable on. See the ทิป in the
   * studio's share flow.
   */
  surface: 'tab' | 'window' | 'monitor' | null;
  /**
   * How many times this share has RECONFIGURED its capture track.
   *
   * 0 or 1, for the whole life of a share, and that ceiling is the fix rather
   * than a statistic — see the note at the top of this file. Exposed so the
   * bench can assert it across twenty layout switches rather than take the
   * absence of a call site as proof.
   */
  reconfigureCount: () => number;
  /**
   * Resolves when the one capture-size decision has been made and the window
   * has closed. The size in effect, or null if nothing was ever asked.
   *
   * Nothing in the studio waits on it — the share is live and correct either
   * way — but the bench does, because "the decision is spent before the
   * creator can tap anything" is the property under test.
   */
  sizeDecided: Promise<{ width: number; height: number } | null>;
  /**
   * Stop the capture and release the source.
   *
   * Idempotent, and it does NOT call `onEnded` — see startScreenShare. A
   * caller that stops the share knows it stopped it.
   */
  stop: () => void;
}

/** Chrome's 'browser' is a tab. Everything else already says what it is. */
function describeSurface(displaySurface: string | undefined): 'tab' | 'window' | 'monitor' | null {
  if (displaySurface === 'browser') return 'tab';
  if (displaySurface === 'window') return 'window';
  if (displaySurface === 'monitor') return 'monitor';
  return null;
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
  /** How the one capture-size decision is measured and announced. */
  options: ScreenShareOptions = {},
): Promise<ScreenShareSession | null> {
  if (!isScreenShareSupported()) return null;

  /**
   * WHAT THIS RUNG ASKS THE BROWSER FOR: a cap, or the monitor itself.
   *
   * `null` at 1080p — the rung whose chart slot is 1080x1248 and can therefore
   * USE a 1440p or 4K source, once the composite reads a cropped region of it
   * rather than the whole frame. 1920x1080 below that. See screenCapturePlanFor
   * for the resample arithmetic that decides it.
   */
  const plan = screenCapturePlanFor(quality);
  /** Where a native capture falls back to when the paint budget says so. */
  const fallbackCap = screenCaptureCapFor();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      /**
       * ==================================================================
       * CAPTURE WHAT THE SLOT CAN USE. AT 1080p THAT IS THE MONITOR ITSELF.
       * ==================================================================
       *
       * PR #64 capped this at 1280x720 and PR #65 raised it to 1920x1080, both
       * for the same correct reason: a 4K frame downscaled by `drawImage` on
       * the main thread thirty times a second is eight million pixels of work
       * in a thread that owes the encoder a finished frame every 33ms, and
       * that was the stutter. No bitrate fixes a frame painted late.
       *
       * WHAT CHANGED IS WHAT THE COMPOSITE READS. In กราฟเต็ม the chart slot
       * is drawn `cover` with a source RECT — a 1246x1440 window on a
       * 2560x1440 monitor, not the whole surface — so the main thread reads
       * 1.79 million pixels per frame rather than 3.69 million. Asking the
       * browser to downscale first would throw away exactly the detail this
       * whole change exists to keep, and would save work the composite is no
       * longer doing.
       *
       * So at 1080p there is NO size constraint: `plan` is null, the browser
       * hands back the source's own frame, and the one resample in the chain
       * is the composite's own crop. Below 1080p the cap stays, because a
       * 720x832 slot cannot use a 1440p source and reading one would cost the
       * budget for nothing.
       *
       * A MAXIMUM, not an exact size, wherever there IS one. `max` is a
       * constraint any source can satisfy by staying under it, so a creator
       * sharing a small window or a 1366x768 laptop screen gets their own
       * resolution untouched and nothing is ever upscaled to meet a target.
       *
       * The framerate cap is unconditional and unchanged: a 60Hz monitor
       * captured at 60 is two decoded frames thrown away for every one
       * painted. 30 is the ceiling the composite could ever consume — it
       * paints at COMPOSITE_FRAME_RATE, which is lower still — and a ceiling
       * on a source is free where dropping frames later is not.
       */
      video: {
        ...(plan ? { width: { max: plan.width }, height: { max: plan.height } } : {}),
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

  /**
   * THE ONE RECONFIGURE THIS SHARE IS ALLOWED, and the flag that makes it one.
   *
   * Every path that would touch the track goes through here, and the first one
   * to arrive spends the budget. There is no second path today — this is what
   * enforces that there cannot be a second one tomorrow either.
   */
  let reconfigures = 0;
  let decided = false;
  let announceDecision: (size: { width: number; height: number } | null) => void = () => {};
  const sizeDecided = new Promise<{ width: number; height: number } | null>((resolve) => {
    announceDecision = resolve;
  });
  const closeDecision = (size: { width: number; height: number } | null) => {
    if (decided) return;
    decided = true;
    announceDecision(size);
  };

  const reconfigureTo = async (
    cap: { width: number; height: number },
    why: string,
  ): Promise<{ width: number; height: number } | null> => {
    if (reconfigures > 0) return null;
    reconfigures += 1;
    const before = track.getSettings();
    // The composite is told BEFORE the track is touched, so the top slot is
    // already black when the frames stop rather than holding a stale one and
    // then reading a decoder that is mid-teardown. See holdSecondSlot.
    options.onReconfigure?.();
    try {
      await track.applyConstraints({
        width: { max: cap.width },
        height: { max: cap.height },
        frameRate: { max: SCREEN_CAPTURE_MAX_FRAME_RATE },
      });
    } catch (err) {
      console.warn('[screen] could not downscale the capture; compositing at source size', err);
      return null;
    }
    const after = track.getSettings();
    console.info(
      `[screen] capture reconfigured once (${why}): ` +
        `${before.width ?? '?'}x${before.height ?? '?'} -> ` +
        `${after.width ?? '?'}x${after.height ?? '?'}`,
    );
    // A reconfigure that ended the track is worth saying out loud: the studio
    // hears it through `onEnded` either way, and this is the line that says
    // which of the two things ended it.
    if (track.readyState === 'ended') {
      console.warn('[screen] the capture ended during the reconfigure');
    }
    return { width: after.width ?? 0, height: after.height ?? 0 };
  };

  /*
    DID THE CONSTRAINT ACTUALLY LAND? Ask, and if not, insist once.

    `getDisplayMedia` constraints are honoured by Chrome and Edge and have a
    history of being ignored elsewhere — Firefox has shipped versions that hand
    back the native surface whatever is asked for. This is the second ask, and
    it is the FIRST claim on the one reconfigure: it happens before the picker
    has even left the screen, which is the only moment at which touching the
    track costs a creator nothing.

    Where there is no plan — the 1080p rung, which asks for the monitor itself
    — there is nothing to insist on, and the budget passes to the decision
    window below.
  */
  if (plan && ((native.width ?? 0) > plan.width || (native.height ?? 0) > plan.height)) {
    await reconfigureTo(plan, 'the browser ignored the capture constraint');
    closeDecision({ width: track.getSettings().width ?? 0, height: track.getSettings().height ?? 0 });
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
  const surface = describeSurface(settings.displaySurface);
  console.info(
    `[screen] sharing ${settings.width ?? '?'}x${settings.height ?? '?'} @${settings.frameRate ?? '?'}fps` +
      capped +
      ` | ${plan ? `cap ${plan.width}x${plan.height}` : 'native (uncapped)'} for ${quality}`,
  );
  /**
   * WHAT THE CREATOR ACTUALLY PICKED, on its own line so it is greppable.
   *
   * Por's recording was of a WINDOW share — the browser's tab strip is in the
   * picture — and a window is both the blurrier source (it is composited by
   * the OS before it is captured) and the one `applyConstraints` is least
   * reliable on. A tab is sharper and carries no chrome. We cannot preselect
   * for a creator, so the studio says which to pick and this says which they
   * did; between the two, "why is it soft?" stops being a guess.
   */
  console.info(`[screen] surface: ${surface ?? 'unknown'}`);

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

  /**
   * ==================================================================
   * THE DECISION, IN THE FIRST SECONDS, AND THEN THE DOOR IS SHUT.
   * ==================================================================
   *
   * Two ways to reach the one reconfigure, and the cheap one goes first:
   *
   *   ON SIGHT. The surface is larger than 1920x1080 AND the machine reports
   *   fewer than eight cores. No measurement is needed for that combination —
   *   it is the case the six-second re-judge was always going to find, and
   *   finding it now costs the creator a reconfigure they never see instead of
   *   one in the middle of their broadcast.
   *
   *   MEASURED, ONCE, at DECISION_WINDOW_MS. The surface is large and the
   *   machine looks capable, so the honest thing is to look: read the
   *   composite's real p95 against its real budget and cap if it is over. The
   *   window closes whatever the answer is.
   *
   * A capture at or under 1920x1080 never reaches either — there is nothing to
   * cap — and the window closes immediately so nothing is left pending.
   *
   * NOTE WHAT DOES NOT APPEAR: the layout. A creator's arrangement has no way
   * into this decision, which is the whole point.
   */
  const nativeSize = { width: settings.width ?? 0, height: settings.height ?? 0 };
  let decisionTimer: ReturnType<typeof setTimeout> | null = null;

  if (!decided) {
    if (nativeSize.width <= fallbackCap.width && nativeSize.height <= fallbackCap.height) {
      closeDecision(nativeSize);
    } else if (
      shouldCapOnSight(
        nativeSize,
        typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency,
      )
    ) {
      console.info(
        `[screen] ${nativeSize.width}x${nativeSize.height} on ` +
          `${navigator.hardwareConcurrency} cores — capping before the composite starts`,
      );
      void reconfigureTo(fallbackCap, 'large surface, few cores').then((size) => {
        closeDecision(size ?? nativeSize);
      });
    } else {
      decisionTimer = setTimeout(() => {
        decisionTimer = null;
        if (finished || track.readyState === 'ended') {
          closeDecision(null);
          return;
        }
        const reading = options.measurePaint?.() ?? null;
        if (!isOverPaintBudget(reading)) {
          console.info(
            `[screen] keeping the native capture — paint p95 ` +
              `${reading ? `${reading.p95}ms of ${reading.budgetMs}ms` : 'not measured'}`,
          );
          closeDecision(nativeSize);
          return;
        }
        console.warn(
          `[screen] paint over ${Math.round(PAINT_BUDGET_LIMIT * 100)}% of budget — ` +
            `p95 ${reading?.p95}ms of ${reading?.budgetMs}ms; capping the capture once`,
        );
        void reconfigureTo(fallbackCap, 'paint budget').then((size) => {
          closeDecision(size ?? nativeSize);
        });
      }, DECISION_WINDOW_MS);
    }
  }

  return {
    stream,
    surface,
    reconfigureCount: () => reconfigures,
    sizeDecided,
    stop: () => {
      if (finished) return;
      finished = true;
      track.removeEventListener('ended', onTrackEnded);
      if (decisionTimer !== null) {
        clearTimeout(decisionTimer);
        decisionTimer = null;
      }
      // Nobody is waiting on this in the studio, but an unresolved promise
      // held by a session that is gone is a leak with a long tail.
      closeDecision(null);
      stream.getTracks().forEach((t) => t.stop());
      console.info('[screen] stopped by the studio');
    },
  };
}
