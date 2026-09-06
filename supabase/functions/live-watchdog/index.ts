/**
 * live-watchdog — close the broadcasts nobody closed.
 *
 * THE BUG THIS EXISTS FOR. `live_sessions.status` only ever became 'ended'
 * because a creator pressed "จบไลฟ์". Close the tab, shut the laptop, lose the
 * connection on a train, and the row stayed 'live' forever: the session kept
 * its slot in "🔴 กำลังไลฟ์ตอนนี้", every viewer who opened it sat on
 * "กำลังเชื่อมต่อ…" waiting for a stream that had stopped, and — the expensive
 * part — the LiveKit RoomComposite egress kept running and kept billing. Two
 * sessions were found open for 16h and 0.8h and had to be ended by hand in SQL.
 *
 * HOW IT IS DECIDED. The studio writes `live_sessions.last_heartbeat_at` every
 * 20 seconds while it is broadcasting (see useLiveHeartbeat). A session whose
 * last beat is older than the grace period is one whose broadcaster is gone.
 * 90 seconds is four missed beats: long enough to ride out a phone changing
 * cell, a laptop sleeping for a moment, or a Realtime reconnect, and short
 * enough that the QA for this — "kill the tab, the session is closed within
 * two minutes" — holds with the once-a-minute cron.
 *
 * WHY IT IS AN EDGE FUNCTION AND NOT PURE SQL. Closing the row is the cheap
 * half. The half that matters is stopping the egress at LiveKit and tidying
 * the stream at Bunny, which are HTTP calls to third parties with credentials
 * in Vault — not something a cron job in Postgres can do. So pg_cron calls
 * `run_live_watchdog()`, which posts here over pg_net, and this runs the SAME
 * `closeLiveSession` the จบไลฟ์ button runs. There is no second close path to
 * drift.
 *
 * ENDED AT THE LAST HEARTBEAT, NOT AT NOW. A session is billed to the last
 * moment it was known to be on air. Billing the 90 seconds the watchdog spent
 * noticing — or the hours before someone fixed a broken cron job — would
 * charge creators for the platform's own detection lag. The lag is recorded in
 * `metadata.watchdog` instead, where it can be looked at.
 *
 * WHO MAY CALL IT. The service role, and nothing else. It closes other
 * people's broadcasts, so a creator's token is not enough and there is no
 * ownership check to fall back on.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getServiceClient,
} from '../_shared/utils.ts';
import { closeLiveSession, type LiveSessionRow } from '../_shared/endLiveSession.ts';

/**
 * How long a session may go unheard from before it is closed.
 *
 * Kept in step with `live_watchdog_grace_seconds()` in the migration, which is
 * what the SQL side uses to decide whom to report. Duplicated rather than
 * fetched because the two are read on every run and a round trip to agree on a
 * constant is not worth it — but they must be changed together.
 */
const GRACE_SECONDS = 90;

/** Never close more than this in one run; the next run picks up the rest. */
const MAX_PER_RUN = 25;

interface WatchdogOutcome {
  session_id: string;
  closed: boolean;
  duration_seconds?: number;
  egress_stopped?: boolean;
  error?: string;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    /**
     * Service role only.
     *
     * The function is deployed with `verify_jwt` on, so Supabase has already
     * rejected anything without a valid token — but a valid token is any
     * signed-in user's, and this closes sessions belonging to other people.
     * Comparing against the service key is what makes the caller the platform
     * rather than a person.
     */
    const authHeader = req.headers.get('Authorization') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!serviceKey || authHeader !== `Bearer ${serviceKey}`) {
      return errorResponse('Service role required', 403, 'forbidden');
    }

    const supabase = getServiceClient();
    const cutoff = new Date(Date.now() - GRACE_SECONDS * 1000).toISOString();

    /**
     * The sessions to close, chosen HERE rather than passed in by the caller.
     *
     * `run_live_watchdog()` could hand over a list, but then a stale list — a
     * session that ended in the seconds between the cron tick and this
     * function waking up — would be closed twice. Re-reading means the
     * selection and the action see the same instant.
     *
     * 'waiting' is included with 'live': live-create-session inserts the row
     * as 'waiting' and only the broadcaster promotes it, so a studio that
     * crashed between the insert and that promotion leaves a 'waiting' row
     * with a heartbeat and no broadcaster — the same orphan, wearing a
     * different status. A row that never beat at all is left alone: it has a
     * NULL heartbeat and no evidence anyone ever went on air.
     */
    const { data: stale, error: readErr } = await supabase
      .from('live_sessions')
      .select('*')
      .in('status', ['live', 'waiting'])
      .not('last_heartbeat_at', 'is', null)
      .lt('last_heartbeat_at', cutoff)
      .order('last_heartbeat_at', { ascending: true })
      .limit(MAX_PER_RUN);

    if (readErr) return errorResponse(readErr.message, 500);

    const sessions = (stale ?? []) as LiveSessionRow[];
    const results: WatchdogOutcome[] = [];

    for (const session of sessions) {
      try {
        const result = await closeLiveSession(supabase, session, {
          endedAt: new Date(session.last_heartbeat_at as string),
          closedBy: 'watchdog',
          // Nobody is left to report a chat tally, so the stored one stands.
        });
        console.log(
          `[live-watchdog] closed ${session.id} after ${result.durationSeconds}s`,
          `(egress_stopped=${result.egressStopped})`,
        );
        results.push({
          session_id: session.id,
          closed: true,
          duration_seconds: result.durationSeconds,
          egress_stopped: result.egressStopped,
        });
      } catch (err) {
        // One session that will not close must not strand the rest — a Bunny
        // outage would otherwise leave every abandoned broadcast open behind
        // the first one.
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[live-watchdog] failed to close ${session.id}`, message);
        results.push({ session_id: session.id, closed: false, error: message });
      }
    }

    return jsonResponse({
      checked_at: new Date().toISOString(),
      grace_seconds: GRACE_SECONDS,
      stale_found: sessions.length,
      closed: results.filter((r) => r.closed).length,
      failed: results.filter((r) => !r.closed).length,
      results,
    });
  } catch (err) {
    console.error('Error:', err);
    return errorResponse(err instanceof Error ? err.message : 'Unknown error', 500);
  }
});
