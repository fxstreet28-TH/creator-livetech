/**
 * live-end-session v2 — close a broadcast and bill it.
 *
 * v1 closed the row and charged `peakViewers × minutes` at LiveKit's
 * per-participant rate, because every viewer really was a LiveKit
 * participant. Under the LL-HLS pipeline they are not, so v2 does two new
 * things:
 *
 *  1. STOPS THE EGRESS. This is the important one. A RoomComposite egress
 *     bills per minute whether or not anyone is watching and does not stop
 *     because the creator closed a tab, so the stop has to happen on the one
 *     code path that definitely runs when a session ends.
 *  2. Splits the bill. LiveKit is now a flat per-stream-minute cost (one
 *     publisher + one egress) and Bunny CDN is the per-viewer-minute one —
 *     which is the entire reason for the migration, and worth being able to
 *     see as two numbers in platform_budget_state rather than one blended one.
 *
 * The Bunny live stream itself is deleted only when the session recorded
 * nothing. Deleting one that has a VOD attached would take the recording with
 * it.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getAuthedCreator,
  getServiceClient,
  getVaultSecrets,
} from '../_shared/utils.ts';
import {
  bunnyDeleteLiveStream,
  bunnyGetLiveStream,
  estimateLiveCost,
  stopEgress,
} from '../_shared/live.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);
    const auth = await getAuthedCreator(req);
    if (!auth) return errorResponse('Not authenticated as creator', 401);

    const body = await req.json();
    if (!body.live_session_id) return errorResponse('live_session_id required', 400);

    /**
     * How many chat lines the broadcaster saw.
     *
     * Chat is a Realtime broadcast and nothing persists it, so
     * `live_sessions.chat_message_count` has no other writer and every session
     * summary reported 0 however busy the chat was. The broadcaster's own
     * tally is the only number that exists.
     *
     * Clamped rather than trusted: it is a client-supplied figure on a vanity
     * metric, so the cost of a wrong one is a wrong number on one creator's
     * own summary — but an unbounded integer would still be an unbounded
     * integer going into a column.
     */
    const reportedChatCount = Math.max(
      0,
      Math.min(1_000_000, Math.floor(Number(body.chat_message_count) || 0)),
    );

    const supabase = getServiceClient();

    const { data: session, error: sessionErr } = await supabase
      .from('live_sessions')
      .select('*')
      .eq('id', body.live_session_id)
      .maybeSingle();

    if (sessionErr) return errorResponse(sessionErr.message, 500);
    if (!session) return errorResponse('Live session not found', 404);
    if (session.creator_id !== auth.creatorId) return errorResponse('Not your session', 403);
    if (session.status === 'ended') {
      return jsonResponse({ already_ended: true, session_id: session.id });
    }

    const secrets = await getVaultSecrets([
      'livekit_ws_url',
      'livekit_api_key',
      'livekit_api_secret',
      'bunny_stream_api_key',
      'bunny_stream_library_id',
    ]);

    // Stop the meter first, before any of the bookkeeping below can fail and
    // leave an egress running.
    if (session.livekit_egress_id) {
      await stopEgress(
        secrets.livekit_ws_url,
        secrets.livekit_api_key,
        secrets.livekit_api_secret,
        session.livekit_egress_id,
      );
    } else if (session.bunny_stream_id) {
      // No id recorded for a session that HAD a Bunny stream: either the egress
      // never started, or start_egress lost track of it. Worth a log line —
      // this is the shape of the 2026-09-01 casing bug, and an egress nobody
      // can name is an egress nobody can stop.
      console.warn('[live-end-session] no egress id recorded for session', session.id);
    }

    /**
     * What Bunny thinks happened, kept verbatim.
     *
     * No broadcast has been recorded through this pipeline yet, so the field
     * carrying the resulting VOD id is not known from the API responses
     * observed during the migration. Snapshotting the final object means the
     * first real recorded session tells us the name instead of us guessing it
     * now and shipping a field that reads undefined forever.
     * TODO(post-launch): read the VOD id out of this and return it properly.
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
        console.error('[live-end-session] Bunny read failed', err);
      }

      // Nothing was recorded, so the stream object is now dead weight in the
      // library. Left in place when recording was on — that object is what
      // owns the VOD.
      if (!session.recording_enabled) {
        try {
          await bunnyDeleteLiveStream(
            secrets.bunny_stream_library_id,
            secrets.bunny_stream_api_key,
            session.bunny_stream_id,
          );
        } catch (err) {
          console.error('[live-end-session] Bunny delete failed', err);
        }
      }
    }

    const endedAt = new Date();
    const startedAt = session.started_at ? new Date(session.started_at) : endedAt;
    const durationSeconds = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
    const durationMinutes = durationSeconds / 60;
    const peakViewers = session.peak_viewer_count ?? 0;

    const cost = estimateLiveCost(durationMinutes, peakViewers);

    const { error: updateErr } = await supabase
      .from('live_sessions')
      .update({
        status: 'ended',
        ended_at: endedAt.toISOString(),
        duration_seconds: durationSeconds,
        estimated_cost_thb: cost.totalThb,
        current_viewer_count: 0,
        // Never lowered: a reconnected broadcaster restarts its tally at zero,
        // and a summary that forgets the first half of the chat is worse than
        // one that keeps the best figure anyone reported.
        chat_message_count: Math.max(session.chat_message_count ?? 0, reportedChatCount),
        updated_at: endedAt.toISOString(),
        metadata: {
          ...(session.metadata && typeof session.metadata === 'object' ? session.metadata : {}),
          ...(bunnyFinal ? { bunny_final: bunnyFinal } : {}),
          cost_breakdown_thb: {
            livekit: Math.round(cost.livekitThb * 100) / 100,
            bunny_cdn: Math.round(cost.bunnyThb * 100) / 100,
          },
        },
      })
      .eq('id', session.id);

    if (updateErr) return errorResponse(`Failed to end session: ${updateErr.message}`, 500);

    const monthKey = new Date()
      .toLocaleString('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' })
      .replace(/(\d{4})-(\d{2}).*/, '$1-$2');

    await supabase.rpc('get_or_create_creator_quota', { p_creator_id: auth.creatorId });

    const { data: currentQuota } = await supabase
      .from('creator_content_quotas')
      .select('live_minutes_used, live_sessions_count, peak_concurrent_viewers, estimated_cost_thb')
      .eq('creator_id', auth.creatorId)
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
          updated_at: endedAt.toISOString(),
        })
        .eq('creator_id', auth.creatorId)
        .eq('month_key', monthKey);
    }

    const { data: budget } = await supabase
      .from('platform_budget_state')
      .select('livekit_cost_thb, bunny_live_cost_thb, total_spent_thb, monthly_budget_thb, warning_threshold_pct, degrade_threshold_pct, emergency_threshold_pct')
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
          status_changed_at: newStatus !== 'normal' ? endedAt.toISOString() : null,
          updated_at: endedAt.toISOString(),
        })
        .eq('month_key', monthKey);
    }

    return jsonResponse({
      session_id: session.id,
      duration_seconds: durationSeconds,
      duration_minutes: Math.round(durationMinutes * 100) / 100,
      peak_viewers: peakViewers,
      chat_messages: Math.max(session.chat_message_count ?? 0, reportedChatCount),
      tips_received_stars: session.tip_stars_received ?? 0,
      estimated_cost_thb: Math.round(cost.totalThb * 100) / 100,
      cost_breakdown_thb: {
        livekit: Math.round(cost.livekitThb * 100) / 100,
        bunny_cdn: Math.round(cost.bunnyThb * 100) / 100,
      },
      // See the bunnyFinal note above — Bunny does produce a VOD when
      // recording is on, but the field naming it has not been observed yet.
      vod_video_id: null,
      recording: session.recording_enabled
        ? { status: 'processing', message: 'Bunny is converting this broadcast to a VOD' }
        : null,
    });
  } catch (err) {
    console.error('Error:', err);
    return errorResponse(err instanceof Error ? err.message : 'Unknown error', 500);
  }
});
