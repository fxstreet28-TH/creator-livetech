'use client';

/**
 * The viewer that fixes itself, because nobody is going to tell a customer to
 * reboot their phone.
 *
 * A phone failed to play a broadcast and a reboot cured it. That is not a bug
 * report anyone can act on, and more importantly it is not a thing to ask of
 * an audience: a viewer who sees a black rectangle leaves, and the one who
 * knows to force-quit Safari is the one who works here. So the page tries the
 * things a person would try, by itself, in order of how much they cost:
 *
 *   0-8s    NORMAL      let the ordinary connect finish. Most "failures" are
 *                       a slow first segment, and tearing anything down here
 *                       would make the common case worse to fix the rare one.
 *   8-20s   RELAY       throw the transport away and build a new one, taking
 *                       the most conservative route available. On WebRTC that
 *                       is literally iceTransportPolicy 'relay' — a TURN
 *                       server instead of a direct path, which is what a
 *                       hostile NAT or a carrier-grade firewall needs. On HLS
 *                       it is the same idea one layer up: a fresh player at
 *                       the conservative latency profile, buffering instead
 *                       of chasing the live edge.
 *   20-35s  REBUILD     the media element itself is suspect. Release the
 *                       source, unmount the <video>, mount a new one, start
 *                       over. This is the rung that beats a wedged decoder,
 *                       which is the failure a reboot fixes.
 *   35s     RELOAD      one hard reload with a cache-busting query, ONCE per
 *                       tab per broadcast. Everything above lives inside a
 *                       page that may itself be the problem.
 *   then    FAILED      stop, and say so in language a person can act on.
 *
 * WHY THE COUNTDOWN IS NOT OPTIONAL. Every one of these rungs looks identical
 * from the outside: a dark screen. A viewer cannot tell "trying again in 6
 * seconds" from "this is never going to work", so without a visible clock they
 * leave during the recovery that would have worked. The countdown is the
 * feature; the ladder underneath it is the implementation.
 *
 * WHAT PAUSES IT. `health: 'paused'` means the CREATOR is not on air yet — no
 * manifest, no publisher — and that is not the viewer's device failing. The
 * clock stops there, because escalating would mean reloading the page of every
 * viewer who arrived thirty seconds early, and the reload would fix nothing.
 * Getting this distinction wrong turns a self-healing viewer into a reload
 * loop, so the players decide it from the actual error rather than from the
 * fact that no picture is showing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { logViewerDiagnostic, type DeliveryPath, type HlsSource } from './viewerDiagnostics';

export type RecoveryStep = 'normal' | 'relay' | 'rebuild' | 'reload' | 'failed';

/**
 * Milliseconds into an unhealthy stretch at which each rung begins.
 *
 * Exported because the copy on screen quotes them and the bench drives them;
 * a countdown computed from different numbers than the escalation would be
 * worse than no countdown at all.
 */
export const RECOVERY_TIMELINE = {
  relay: 8_000,
  rebuild: 20_000,
  reload: 35_000,
} as const;

/** How often the ladder looks at the clock. Twice a second; renders are gated. */
const TICK_MS = 500;

/**
 * What the player says about itself.
 *
 * 'paused' is the load-bearing one — see the header. It is NOT "no picture";
 * it is "there is nothing to show yet and that is the creator's side".
 */
export type PlaybackHealth = 'healthy' | 'unhealthy' | 'paused';

export interface RecoveryLadder {
  step: RecoveryStep;
  /**
   * Bumped whenever the player must throw everything away and re-attach.
   *
   * The player puts this in its effect dependencies, and in the <video>'s
   * `key` for the rebuild rung. A number rather than a boolean because two
   * consecutive rebuilds have to be two distinct events.
   */
  attemptKey: number;
  /**
   * Bumped ONLY when the media element itself must be thrown away.
   *
   * Separate from attemptKey because the rungs are deliberately different in
   * cost: 'relay' rebuilds the transport around the same <video>, which keeps
   * whatever the browser has already decoded; 'rebuild' replaces the element,
   * which is the expensive rung that beats a wedged decoder. Keying the
   * element off attemptKey would collapse the two and make every retry the
   * expensive one.
   */
  rebuildKey: number;
  /** Whole seconds until the next rung. Null when there is not one. */
  secondsToNextStep: number | null;
  /** The ladder is spent: show the error card. */
  exhausted: boolean;
  /** The card's button. Starts the whole ladder again from the top. */
  retryNow: () => void;
  /**
   * Force an immediate re-attach without resetting an escalation already in
   * progress — for the wake and watchdog detectors, which have found a broken
   * player rather than started a new attempt.
   *
   * `rebuild` also throws the <video> ELEMENT away, which is the 'rebuild'
   * rung's expensive trick rather than the cheap re-attach the other callers
   * want. It exists for the resume path: a media element iOS suspended in the
   * background is precisely the wedged decoder that rung was written for, and
   * making a returning viewer wait out the 8s and 20s boundaries to reach it —
   * on a signal as strong as the OS handing the page back — is twenty seconds
   * of black screen spent proving something already known.
   */
  restartNow: (
    reason: 'wake' | 'watchdog',
    detail?: Record<string, unknown>,
    options?: { rebuild?: boolean },
  ) => void;
}

function stepFor(elapsedMs: number): RecoveryStep {
  if (elapsedMs < RECOVERY_TIMELINE.relay) return 'normal';
  if (elapsedMs < RECOVERY_TIMELINE.rebuild) return 'relay';
  if (elapsedMs < RECOVERY_TIMELINE.reload) return 'rebuild';
  return 'reload';
}

function nextBoundary(step: RecoveryStep): number | null {
  if (step === 'normal') return RECOVERY_TIMELINE.relay;
  if (step === 'relay') return RECOVERY_TIMELINE.rebuild;
  if (step === 'rebuild') return RECOVERY_TIMELINE.reload;
  return null;
}

/**
 * The one automatic reload, and the flag that keeps it to one.
 *
 * Returns false when it did NOT reload, which the caller turns into the error
 * card. Two ways that happens, and both are deliberate:
 *
 *  - it has already been used for this broadcast in this tab. A page that
 *    reloads itself every 35 seconds is not self-healing, it is a device that
 *    can never show an error and never be read.
 *  - sessionStorage threw (private browsing, storage disabled). With no way
 *    to REMEMBER having reloaded, reloading would be the loop above with no
 *    way out, so the honest move is to skip the rung entirely.
 *
 * `location.replace` rather than `reload()`: the URL changes (that is the
 * cache-buster) and this must not put a dead page into the back button.
 */
function hardReloadOnce(sessionId: string): boolean {
  const key = `live:recovery-reloaded:${sessionId}`;
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
  } catch {
    return false;
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('r', String(Date.now()));
    window.location.replace(url.toString());
    return true;
  } catch {
    return false;
  }
}

export interface UseRecoveryLadderOptions {
  sessionId: string;
  delivery: DeliveryPath;
  /**
   * Which server produced the playlist, on the 'hls' path.
   *
   * Attached to every row this ladder writes so a recovery story can be
   * attributed to Bunny Live or to origin-sg-1. Undefined on 'livekit', which
   * has no playlist and no such distinction.
   */
  source?: HlsSource;
  health: PlaybackHealth;
  /** Off while there is nothing to play — an ended or locked broadcast. */
  enabled?: boolean;
}

export function useRecoveryLadder({
  sessionId,
  delivery,
  source,
  health,
  enabled = true,
}: UseRecoveryLadderOptions): RecoveryLadder {
  const [step, setStep] = useState<RecoveryStep>('normal');
  const [attemptKey, setAttemptKey] = useState(0);
  const [rebuildKey, setRebuildKey] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  /**
   * Everything the tick reads lives in a ref.
   *
   * The loop below is one interval for the life of the component rather than
   * an effect that restarts whenever health changes: a ladder whose clock is
   * reset by its own dependencies would never reach the second rung. So the
   * inputs are refs, updated as they change, and the interval is the only
   * thing that moves the machine.
   */
  const healthRef = useRef(health);
  const stepRef = useRef(step);
  const attemptRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const shownSecondRef = useRef(-1);
  const exhaustedRef = useRef(false);

  useEffect(() => {
    healthRef.current = health;
  }, [health]);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    exhaustedRef.current = exhausted;
  }, [exhausted]);

  const reset = useCallback((from: 'button' | 'recovered') => {
    startedAtRef.current = null;
    shownSecondRef.current = -1;
    stepRef.current = 'normal';
    exhaustedRef.current = false;
    setStep('normal');
    setExhausted(false);
    setElapsedMs(0);
    if (from === 'button') {
      attemptRef.current += 1;
      setAttemptKey((n) => n + 1);
      // A viewer who taps the button has already watched the automatic ladder
      // fail, so this starts from the most thorough thing short of a reload.
      setRebuildKey((n) => n + 1);
    }
  }, []);

  const retryNow = useCallback(() => {
    logViewerDiagnostic({
      sessionId,
      delivery,
      source,
      step: 'normal',
      outcome: 'entered',
      attempt: attemptRef.current + 1,
      detail: { trigger: 'viewer_tapped_retry' },
    });
    reset('button');
  }, [sessionId, delivery, source, reset]);

  const restartNow = useCallback(
    (
      reason: 'wake' | 'watchdog',
      detail?: Record<string, unknown>,
      options?: { rebuild?: boolean },
    ) => {
      logViewerDiagnostic({
        sessionId,
        delivery,
        source,
        step: reason,
        outcome: 'detected',
        attempt: attemptRef.current,
        elapsedMs: startedAtRef.current ? Date.now() - startedAtRef.current : 0,
        detail,
      });
      // The clock is NOT reset when one is already running: a watchdog that
      // fires every ten seconds would otherwise hold the ladder on its first
      // rung forever, which is the one outcome worse than not having a
      // watchdog. A fresh attach, and the escalation carries on from where it
      // had got to.
      startedAtRef.current ??= Date.now();
      exhaustedRef.current = false;
      setExhausted(false);
      attemptRef.current += 1;
      setAttemptKey((n) => n + 1);
      if (options?.rebuild) setRebuildKey((n) => n + 1);
    },
    [sessionId, delivery, source],
  );

  useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      const current = healthRef.current;

      if (current === 'healthy') {
        if (startedAtRef.current !== null) {
          // The rung that was in effect when the picture came back is the one
          // that fixed it, and that pairing is the entire point of the table.
          logViewerDiagnostic({
            sessionId,
            delivery,
            source,
            step: stepRef.current,
            outcome: 'recovered',
            attempt: attemptRef.current,
            elapsedMs: Date.now() - startedAtRef.current,
          });
          reset('recovered');
        }
        return;
      }

      if (current === 'paused') {
        // The creator is not on air. Not this device's problem, and the clock
        // starts fresh if playback fails once frames do arrive.
        startedAtRef.current = null;
        shownSecondRef.current = -1;
        return;
      }

      if (exhaustedRef.current) return;

      startedAtRef.current ??= Date.now();
      const elapsed = Date.now() - startedAtRef.current;

      // Re-render on the SECOND, not on the tick: the countdown moves once a
      // second and this loop runs twice as often as that.
      const second = Math.floor(elapsed / 1000);
      if (second !== shownSecondRef.current) {
        shownSecondRef.current = second;
        setElapsedMs(elapsed);
      }

      const target = stepFor(elapsed);
      if (target === stepRef.current) return;

      logViewerDiagnostic({
        sessionId,
        delivery,
        source,
        step: stepRef.current,
        outcome: 'timed_out',
        attempt: attemptRef.current,
        elapsedMs: elapsed,
      });

      if (target === 'reload') {
        const reloading = hardReloadOnce(sessionId);
        logViewerDiagnostic({
          sessionId,
          delivery,
          source,
          step: 'reload',
          outcome: reloading ? 'entered' : 'skipped',
          attempt: attemptRef.current,
          elapsedMs: elapsed,
        });
        if (reloading) {
          // The page is going away; leave the state as it is rather than
          // painting a card nobody will see.
          stepRef.current = 'reload';
          setStep('reload');
          return;
        }
        logViewerDiagnostic({
          sessionId,
          delivery,
          source,
          step: 'failed',
          outcome: 'gave_up',
          attempt: attemptRef.current,
          elapsedMs: elapsed,
        });
        stepRef.current = 'failed';
        exhaustedRef.current = true;
        setStep('failed');
        setExhausted(true);
        return;
      }

      attemptRef.current += 1;
      stepRef.current = target;
      setStep(target);
      setAttemptKey((n) => n + 1);
      if (target === 'rebuild') setRebuildKey((n) => n + 1);
      logViewerDiagnostic({
        sessionId,
        delivery,
        source,
        step: target,
        outcome: 'entered',
        attempt: attemptRef.current,
        elapsedMs: elapsed,
      });
    };

    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, sessionId, delivery, source, reset]);

  const boundary = nextBoundary(step);
  const secondsToNextStep =
    boundary === null || exhausted ? null : Math.max(0, Math.ceil((boundary - elapsedMs) / 1000));

  return { step, attemptKey, rebuildKey, secondsToNextStep, exhausted, retryNow, restartNow };
}
