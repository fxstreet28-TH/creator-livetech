'use client';

/**
 * What the self-healing viewer did, written where we can query it.
 *
 * A viewer's phone would not play a broadcast today, and rebooting it fixed
 * the problem. That is the only fact anybody has, and it cannot be acted on:
 * it does not say whether the connect never finished, the decoder wedged
 * mid-stream, or the phone was running a bundle from three deploys ago. The
 * recovery ladder now tries four increasingly violent things by itself, and
 * every rung it enters — and whether that rung worked — is recorded here.
 *
 * The value is in the PAIRING. One row for entering a step and one for how it
 * ended turns the table into "relay fixed 40 of 44 iPhones and none of the
 * Androids", which is something to act on. A single "playback failed" row is
 * the reboot story again.
 *
 * FAILING TO LOG IS NEVER A FAILURE. Every call here is fire-and-forget and
 * every error is swallowed: this is instrumentation on the screen a viewer
 * watches, and a diagnostics write that threw — or that blocked — would break
 * the very thing it is measuring. There is no retry and no queue for the same
 * reason.
 *
 * WHAT IT IS NOT. Not analytics, not a funnel, not read back by any product
 * surface. It carries no message contents, no viewer identity beyond the
 * user id the database takes from the session itself, and no URL — see the
 * migration for the write path, which is deliberately narrow because a
 * logged-out viewer has to be able to reach it.
 */

import { getBrowserSupabase } from '@/lib/supabase-browser';
import { RUNNING_BUILD_ID } from './buildId';

/** Which rung, or which detector fired. Must match the migration's list. */
export type DiagnosticStep =
  | 'normal'
  | 'relay'
  | 'rebuild'
  | 'reload'
  | 'failed'
  | 'stale_build'
  | 'wake'
  | 'watchdog';

/** What became of it. Must match the migration's list. */
export type DiagnosticOutcome =
  | 'entered'
  | 'recovered'
  | 'timed_out'
  | 'skipped'
  | 'gave_up'
  | 'detected';

export type DeliveryPath = 'hls' | 'livekit';

/**
 * Which server produced the HLS playlist, when `delivery` is 'hls'.
 *
 * NOT part of `delivery`, and that is a schema constraint rather than a
 * preference: `log_live_viewer_diagnostic` writes p_delivery into a column with
 * a CHECK on exactly ('hls','livekit'), so a third value would be rejected at
 * the database and every diagnostic row would be silently lost — on the path
 * where losing them costs the most, since a viewer who cannot play is the whole
 * reason the table exists. It rides in the jsonb `detail` instead, which has no
 * such constraint.
 */
export type HlsSource = 'llhls' | 'origin';

export interface DiagnosticEvent {
  sessionId: string;
  step: DiagnosticStep;
  outcome: DiagnosticOutcome;
  delivery: DeliveryPath;
  /**
   * Bunny Live, or our own origin-sg-1. Merged into `detail` on the way out.
   *
   * "HLS playback failed" names a symptom with two owners and two different
   * fixes; this is what makes a row point at one of them.
   */
  source?: HlsSource;
  attempt?: number;
  elapsedMs?: number;
  detail?: Record<string, unknown>;
}

const CLIENT_ID_KEY = 'live:diagnostic-client-id';

/**
 * One id per TAB, which is the unit a ladder actually runs in.
 *
 * sessionStorage rather than localStorage on purpose: two tabs on the same
 * broadcast are two independent players that can fail differently, and giving
 * them one id would interleave their rows into a story that never happened.
 * It survives the ladder's own reload, which is the point — the rows from
 * before the reload and after it have to join up.
 */
function clientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const fresh =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `c${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(CLIENT_ID_KEY, fresh);
    return fresh;
  } catch {
    // Private mode, or storage disabled. An unstable id is worth more than no
    // row: the step and outcome are still true, only the joining is lost.
    return 'unstable';
  }
}

/**
 * Record one ladder event. Never throws, never blocks, never retries.
 */
export function logViewerDiagnostic(event: DiagnosticEvent): void {
  // Merged rather than assigned, and the caller's own keys win: `detail` is the
  // free-form half of the row and a caller that has already said something
  // about the source knows more than this default does.
  const detail = event.source ? { source: event.source, ...event.detail } : event.detail;

  // Mirrored to the console unconditionally. On the device that is actually
  // broken, a USB cable and Safari's inspector are the fastest path to the
  // answer, and that device is frequently the one whose network write fails.
  console.info(
    `[live/recovery] ${event.step} -> ${event.outcome} (${event.delivery}` +
      `${event.attempt ? `, attempt ${event.attempt}` : ''}` +
      `${event.elapsedMs ? `, ${event.elapsedMs}ms` : ''})`,
    detail ?? '',
  );

  try {
    const supabase = getBrowserSupabase();
    void supabase
      .rpc('log_live_viewer_diagnostic', {
        p_session_id: event.sessionId,
        p_client_id: clientId(),
        p_step: event.step,
        p_outcome: event.outcome,
        p_delivery: event.delivery,
        p_attempt: event.attempt ?? 0,
        p_elapsed_ms: Math.round(event.elapsedMs ?? 0),
        p_build_id: RUNNING_BUILD_ID,
        p_user_agent: typeof navigator === 'undefined' ? null : navigator.userAgent,
        p_detail: detail ?? null,
      })
      .then(
        () => undefined,
        () => undefined,
      );
  } catch {
    // getBrowserSupabase throws when the env is not configured. Nothing here
    // is worth surfacing to someone trying to watch a broadcast.
  }
}
