/**
 * check-platform-budget — the cron that maintains the kill switch.
 *
 * Recomputes the month's spend from `creator_content_quotas` and moves
 * `platform_budget_state.status` across the warning / degraded / emergency
 * thresholds. That status is what `check_creator_can_golive` refuses on, and
 * what live-get-playback-url turns away viewers on at 'emergency'.
 *
 * WHAT THE LL-HLS MIGRATION CHANGED HERE
 *
 * Live streaming used to be one cost line — LiveKit, scaling with viewers.
 * It is now two, and they scale with completely different things:
 *
 *   livekit_cost_thb      one publisher plus one RoomComposite egress. Flat
 *                         per stream-minute. Does NOT grow with the audience.
 *   bunny_live_cost_thb   CDN delivery to viewers, per viewer-minute, at about
 *                         a tenth of what LiveKit charged for the same viewer.
 *
 * Both are already computed per session by live-end-session, which knows the
 * duration and the peak audience, and both are accumulated into
 * `creator_content_quotas.estimated_cost_thb`. This function's job is to split
 * that total back out, which it does with the same ratio the estimator used —
 * see LIVE_COST_SPLIT below.
 *
 * verify_jwt is off because pg_cron calls this with the service role key in
 * the Authorization header, which the body checks itself.
 */

import { handleCors, jsonResponse, errorResponse, getServiceClient } from '../_shared/utils.ts';

/**
 * Bunny's share of a live session's bill.
 *
 * live-end-session is the authority — it prices each session from the actual
 * duration and peak — but it writes into `platform_budget_state` directly and
 * this function RECOMPUTES that table from the quota rows, which carry only a
 * blended `estimated_cost_thb`. Rather than adding a second pair of columns to
 * creator_content_quotas mid-migration, the blended figure is split back with
 * the ratio a typical session produces.
 *
 * At the reference session the cost model is built on — one hour, 500 peak
 * viewers — Bunny is ~78% of the total. A stream with a smaller audience skews
 * toward LiveKit's flat cost, so this is an approximation, and the TOTAL,
 * which is what every threshold is compared against, is exact either way.
 * TODO(post-launch): carry the two lines through creator_content_quotas so
 * this split is not needed.
 */
const LIVE_COST_SPLIT_BUNNY = 0.78;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get('Authorization');
    const expected = `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`;
    if (authHeader !== expected) return errorResponse('Service role required', 401);

    const supabase = getServiceClient();
    const monthKey = new Date()
      .toLocaleString('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' })
      .replace(/(\d{4})-(\d{2}).*/, '$1-$2');

    let { data: budget } = await supabase
      .from('platform_budget_state')
      .select('*')
      .eq('month_key', monthKey)
      .maybeSingle();

    if (!budget) {
      const { data: newBudget } = await supabase
        .from('platform_budget_state')
        .insert({ month_key: monthKey, monthly_budget_thb: 10000 })
        .select('*')
        .single();
      budget = newBudget;
    }

    const { data: videoStats } = await supabase
      .from('creator_content_quotas')
      .select('total_video_minutes_uploaded, total_storage_gb, live_minutes_used, estimated_cost_thb')
      .eq('month_key', monthKey);

    let bunnyStreamCostThb = 0;
    let bunnyStorageCostThb = 0;
    let liveCostThb = 0;

    for (const row of videoStats ?? []) {
      // VOD encoding and storage — unchanged by this migration.
      bunnyStreamCostThb += Number(row.total_video_minutes_uploaded ?? 0) * 0.005 * 35;
      bunnyStorageCostThb += Number(row.total_storage_gb ?? 0) * 0.01 * 35;
      liveCostThb += Number(row.estimated_cost_thb ?? 0);
    }

    const bunnyLiveCostThb = liveCostThb * LIVE_COST_SPLIT_BUNNY;
    const livekitCostThb = liveCostThb - bunnyLiveCostThb;

    const totalSpentThb = bunnyStreamCostThb + bunnyStorageCostThb + liveCostThb;
    const monthlyBudget = Number(budget.monthly_budget_thb);
    const pctUsed = (totalSpentThb / monthlyBudget) * 100;

    const previousStatus = budget.status;
    let newStatus = 'normal';
    let statusReason = 'Under warning threshold';

    if (pctUsed >= Number(budget.emergency_threshold_pct)) {
      newStatus = 'emergency';
      statusReason = `Budget at ${pctUsed.toFixed(1)}% (emergency threshold ${budget.emergency_threshold_pct}%)`;
    } else if (pctUsed >= Number(budget.degrade_threshold_pct)) {
      newStatus = 'degraded';
      statusReason = `Budget at ${pctUsed.toFixed(1)}% (degrade threshold ${budget.degrade_threshold_pct}%)`;
    } else if (pctUsed >= Number(budget.warning_threshold_pct)) {
      newStatus = 'warning';
      statusReason = `Budget at ${pctUsed.toFixed(1)}% (warning threshold ${budget.warning_threshold_pct}%)`;
    }

    const updateFields: Record<string, unknown> = {
      bunny_stream_cost_thb: bunnyStreamCostThb,
      bunny_storage_cost_thb: bunnyStorageCostThb,
      bunny_live_cost_thb: bunnyLiveCostThb,
      livekit_cost_thb: livekitCostThb,
      total_spent_thb: totalSpentThb,
      status: newStatus,
      updated_at: new Date().toISOString(),
      last_bunny_sync_at: new Date().toISOString(),
      last_livekit_sync_at: new Date().toISOString(),
    };

    if (previousStatus !== newStatus) {
      const actionsLog = Array.isArray(budget.actions_log) ? budget.actions_log : [];
      actionsLog.push({
        timestamp: new Date().toISOString(),
        previous_status: previousStatus,
        new_status: newStatus,
        reason: statusReason,
        pct_used: Math.round(pctUsed * 10) / 10,
        spent_thb: Math.round(totalSpentThb * 100) / 100,
      });
      updateFields.actions_log = actionsLog;
      updateFields.status_changed_at = new Date().toISOString();
      updateFields.status_change_reason = statusReason;
    }

    await supabase.from('platform_budget_state').update(updateFields).eq('month_key', monthKey);

    return jsonResponse({
      month_key: monthKey,
      status: newStatus,
      previous_status: previousStatus,
      status_changed: previousStatus !== newStatus,
      pct_used: Math.round(pctUsed * 10) / 10,
      breakdown: {
        bunny_stream_thb: Math.round(bunnyStreamCostThb * 100) / 100,
        bunny_storage_thb: Math.round(bunnyStorageCostThb * 100) / 100,
        bunny_live_thb: Math.round(bunnyLiveCostThb * 100) / 100,
        livekit_thb: Math.round(livekitCostThb * 100) / 100,
        total_thb: Math.round(totalSpentThb * 100) / 100,
        budget_thb: monthlyBudget,
      },
      reason: statusReason,
    });
  } catch (err) {
    console.error('Budget check error:', err);
    return errorResponse(err instanceof Error ? err.message : 'Unknown error', 500);
  }
});
