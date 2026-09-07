/**
 * Closing a broadcast: the provider teardown, the row, the quota and the bill.
 *
 * WHY THIS IS A MODULE AND NOT JUST live-end-session's BODY
 *
 * There are two ways a session ends, and only one of them involves a creator:
 *
 *   1. "จบไลฟ์" — live-end-session, authenticated as the creator.
 *   2. The creator's browser stopped reporting — live-watchdog, running as the
 *      service role on a pg_cron schedule, for a tab that was closed or a
 *      laptop that was shut.
 *
 * Those differ in WHO asks and in WHAT TIME the session is deemed to have
 * ended. Everything after that has to be identical, because the expensive half
 * of ending a session is stopping the LiveKit egress — which bills per minute
 * whether or not anyone is watching, and does not stop because a tab closed.
 * A watchdog that closed the row without stopping the egress would turn a
 * visible bug (a session stuck on the dashboard) into an invisible one (a
 * meter running with nothing on the dashboard to show for it).
 *
 * So the stop path lives here, once, and both callers run it.
 */

import { getVaultSecrets } from './utils.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  bunnyDeleteLiveStream,
  bunnyGetLiveStream,
  estimateLiveCost,
  stopEgress,
} from './live.ts';
import type { LiveDeliveryMode } from './live.ts';

/** The `live_sessions` row, as this module reads it. */
export interface LiveSessionRow {
  id: string;
  creator_id: string;
  status: string;
  started_at: string | null;
  peak_viewer_count: number | null;
  chat_message_count: number | null;
  tip_stars_received: number | null;
  recording_enabled: boolean | null;
  bunny_stream_id: string | null;
  livekit_egress_id: string | null;
  /** Set only on a session carried by our own MediaMTX. See estimateLiveCost. */
  origin_room_id?: string | null;
  metadata: unknown;
  [key: string]: unknown;
}

/**
 * Who closed the session, recorded on the row.
 *
 * Not decoration. "Did the watchdog have to clean this up, and how often?" is
 * the question that says whether the heartbeat is actually working, and it
 * cannot be answered from a row that only records THAT it ended.
 */
export type ClosedBy = 'creator' | 'watchdog';

export interface CloseLiveSessionOptions {
  /**
   * When the broadcast is deemed to have stopped.
   *
   * `now` for "จบไลฟ์" — the creator is here, pressing the button. The
   * watchdog passes the LAST HEARTBEAT instead, because that is the last
   * moment anything is known to have been on air; billing the ninety seconds
   * the watchdog spent noticing, or the hour before a cron job was fixed,
   * would charge the creator for the platform's own detection lag.
   */
  endedAt: Date;
  closedBy: ClosedBy;
  /**
   * The broadcaster's own chat tally. Absent from the watchdog path — there is
   * nobody left to report it — and the stored value is kept in that case.
   *
   * Chat is a Realtime broadcast and nothing persists it, so this is the only
   * number that exists. Clamped rather than trusted: it is client-supplied,
   * and the cost of a wrong one is a wrong figure on one creator's own summary.
   */
  reportedChatCount?: number;
}

export interface CloseLiveSessionResult {
  sessionId: string;
  durationSeconds: number;
  durationMinutes: number;
  peakViewers: number;
  chatMessages: number;
  tipStarsReceived: number;
  costThb: number;
  costBreakdownThb: { livekit: number; bunny_cdn: number };
  recordingEnabled: boolean;
  /** True when the egress stop was attempted and LiveKit accepted it. */
  egressStopped: boolean;
}

function clampChatCount(value: unknown): number {
  return Math.max(0, Math.min(1_000_000, Math.floor(Number(value) || 0)));
}

/**
 * Stop the stream at the provider, close the row, and post the session's cost
 * to the creator's quota and the platform budget.
 *
 * Assumes the caller has already established that the session exists, is not
 * already ended, and may be closed by whoever is asking. It does NOT re-check
 * ownership — live-end-session checks the creator, and live-watchdog closes on
 * the platform's behalf.
 */
export async function closeLiveSession(
  supabase: SupabaseClient,
  session: LiveSessionRow,
  options: CloseLiveSessionOptions,
): Promise<CloseLiveSessionResult> {
  const { endedAt, closedBy } = options;

  const secrets = await getVaultSecrets([
    'livekit_ws_url',
    'livekit_api_key',
    'livekit_api_secret',
    'bunny_stream_api_key',
    'bunny_stream_library_id',
  ]);

  // The meter first, before any of the bookkeeping below can fail and leave an
  // egress running.
  let egressStopped = false;
  if (session.livekit_egress_id) {
    egressStopped = await stopEgress(
      secrets.livekit_ws_url,
      secrets.livekit_api_key,
      secrets.livekit_api_secret,
      session.livekit_egress_id,
    );
  } else if (session.bunny_stream_id) {
    // No id recorded for a session that HAD a Bunny stream: either the egress
    // never started, or start_egress lost track of it. Worth a log line — this
    // is the shape of the 2026-09-01 casing bug, and an egress nobody can name
    // is an egress nobody can stop.
    console.warn('[closeLiveSession] no egress id recorded for session', session.id);
  }

  /**
   * What Bunny thinks happened, kept verbatim. See live-end-session's original
   * note: the field carrying the resulting VOD id has not been observed yet,
   * so the whole object is snapshotted rather than a name being guessed.
   */
  let bunnyFinal: Record<string, unknown> | null = null;
  if (session.bunny_stream_id) {
    try {
      bunnyFinal = (await bunnyGetLiveStream(
        secrets.bunny_stream_library_id,
        secrets.bunny_stream_api_key,
        session.bunny_stream_id,
      )) as unknown as Record<string, unknown> | null;
    } catch (err) {
      console.error('[closeLiveSession] Bunny read failed', err);
    }

    // Nothing was recorded, so the stream object is now dead weight in the
    // library. Left in place when recording was on — that object owns the VOD.
    if (!session.recording_enabled) {
      try {
        await bunnyDeleteLiveStream(
          secrets.bunny_stream_library_id,
          secrets.bunny_stream_api_key,
          session.bunny_stream_id,
        );
      } catch (err) {
        console.error('[closeLiveSession] Bunny delete failed', err);
      }
    }
  }

  const startedAt = session.started_at ? new Date(session.started_at) : endedAt;
  /**
   * Never negative.
   *
   * The watchdog's `endedAt` is a heartbeat timestamp, and a session whose
   * only heartbeat predates its own `started_at` — a clock skew, a row
   * promoted to 'live' after its first beat — would otherwise produce a
   * negative duration and a negative bill.
   */
  const durationSeconds = Math.max(
    0,
    Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
  );
  const durationMinutes = durationSeconds / 60;
  const peakViewers = session.peak_viewer_count ?? 0;
  const storedChatCount = session.chat_message_count ?? 0;
  // Never lowered: a reconnected broadcaster restarts its tally at zero, and a
  // summary that forgets the first half of the chat is worse than one that
  // keeps the best figure anyone reported.
  const chatMessages =
    options.reportedChatCount === undefined
      ? storedChatCount
      : Math.max(storedChatCount, clampChatCount(options.reportedChatCount));

  /**
   * Which pipeline carried this, read from the row rather than from the vault.
   *
   * `live_delivery_mode` says what the NEXT session will get, not what this one
   * got — and a session that was on air while the mode was flipped would
   * otherwise be priced as the pipeline it was never on. `origin_room_id` is
   * set at create and never changes, so it is the honest record.
   */
  const delivery: LiveDeliveryMode = session.origin_room_id ? 'origin' : 'llhls';
  const cost = estimateLiveCost(durationMinutes, peakViewers, delivery);
  const nowIso = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from('live_sessions')
    .update({
      status: 'ended',
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
      estimated_cost_thb: cost.totalThb,
      current_viewer_count: 0,
      chat_message_count: chatMessages,
      updated_at: nowIso,
      metadata: {
        ...(session.metadata && typeof session.metadata === 'object' ? session.metadata : {}),
        ...(bunnyFinal ? { bunny_final: bunnyFinal } : {}),
        cost_breakdown_thb: {
          livekit: Math.round(cost.livekitThb * 100) / 100,
          bunny_cdn: Math.round(cost.bunnyThb * 100) / 100,
        },
        closed_by: closedBy,
        ...(closedBy === 'watchdog'
          ? {
              watchdog: {
                closed_at: nowIso,
                // The gap the creator is NOT billed for: between their last
                // heartbeat and the moment anyone noticed.
                detection_lag_seconds: Math.max(
                  0,
                  Math.round((Date.now() - endedAt.getTime()) / 1000),
                ),
                egress_stopped: egressStopped,
              },
            }
          : {}),
      },
    })
    .eq('id', session.id)
    // Losing this race is the correct outcome, not an error: the creator's own
    // "จบไลฟ์" landing while the watchdog was mid-flight should win, and the
    // second writer must not re-post the cost to the quota below.
    .neq('status', 'ended');

  if (updateErr) {
    throw new Error(`Failed to end session: ${updateErr.message}`);
  }

  const monthKey = new Date()
    .toLocaleString('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' })
    .replace(/(\d{4})-(\d{2}).*/, '$1-$2');

  await supabase.rpc('get_or_create_creator_quota', { p_creator_id: session.creator_id });

  const { data: currentQuota } = await supabase
    .from('creator_content_quotas')
    .select('live_minutes_used, live_sessions_count, peak_concurrent_viewers, estimated_cost_thb')
    .eq('creator_id', session.creator_id)
    .eq('month_key', monthKey)
    .single();

  if (currentQuota) {
    await supabase
      .from('creator_content_quotas')
      .update({
        live_minutes_used: Number(currentQuota.live_minutes_used ?? 0) + durationMinutes,
        live_sessions_count: (currentQuota.live_sessions_count ?? 0) + 1,
        peak_concurrent_viewers: Math.max(peakViewers, currentQuota.peak_concurrent_viewers ?? 0),
        estimated_cost_thb: Number(currentQuota.estimated_cost_thb ?? 0) + cost.totalThb,
        updated_at: nowIso,
      })
      .eq('creator_id', session.creator_id)
      .eq('month_key', monthKey);
  }

  const { data: budget } = await supabase
    .from('platform_budget_state')
    .select(
      'livekit_cost_thb, bunny_live_cost_thb, total_spent_thb, monthly_budget_thb, warning_threshold_pct, degrade_threshold_pct, emergency_threshold_pct',
    )
    .eq('month_key', monthKey)
    .single();

  if (budget) {
    const newLivekitCost = Number(budget.livekit_cost_thb ?? 0) + cost.livekitThb;
    const newBunnyLiveCost = Number(budget.bunny_live_cost_thb ?? 0) + cost.bunnyThb;
    const newTotalSpent = Number(budget.total_spent_thb ?? 0) + cost.totalThb;
    const pctUsed = (newTotalSpent / Number(budget.monthly_budget_thb)) * 100;

    let newStatus = 'normal';
    if (pctUsed >= Number(budget.emergency_threshold_pct)) newStatus = 'emergency';
    else if (pctUsed >= Number(budget.degrade_threshold_pct)) newStatus = 'degraded';
    else if (pctUsed >= Number(budget.warning_threshold_pct)) newStatus = 'warning';

    await supabase
      .from('platform_budget_state')
      .update({
        livekit_cost_thb: newLivekitCost,
        bunny_live_cost_thb: newBunnyLiveCost,
        total_spent_thb: newTotalSpent,
        status: newStatus,
        status_changed_at: newStatus !== 'normal' ? nowIso : null,
        updated_at: nowIso,
      })
      .eq('month_key', monthKey);
  }

  return {
    sessionId: session.id,
    durationSeconds,
    durationMinutes,
    peakViewers,
    chatMessages,
    tipStarsReceived: session.tip_stars_received ?? 0,
    costThb: cost.totalThb,
    costBreakdownThb: {
      livekit: Math.round(cost.livekitThb * 100) / 100,
      bunny_cdn: Math.round(cost.bunnyThb * 100) / 100,
    },
    recordingEnabled: session.recording_enabled ?? false,
    egressStopped,
  };
}
