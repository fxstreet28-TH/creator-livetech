/**
 * live-end-session v3 — the creator pressed "จบไลฟ์".
 *
 * v1 closed the row and charged `peakViewers × minutes` at LiveKit's
 * per-participant rate. v2 moved to the LL-HLS pipeline: it stops the egress —
 * a RoomComposite egress bills per minute whether or not anyone is watching —
 * and splits the bill into a flat LiveKit line and a per-viewer Bunny one.
 *
 * v3 does not change any of that. It MOVES it, into
 * `_shared/endLiveSession.ts`, so that live-watchdog closes an abandoned
 * session down exactly the same path rather than down a second one that has to
 * be kept in step. What is left here is what is specific to a creator asking:
 * the auth, the ownership check, their chat tally, and the summary screen's
 * response shape.
 *
 * SEE ALSO the beacon. `endLiveSessionBeacon` in lib/live/api.ts posts to this
 * same function from `pagehide`, with the access token in the BODY because
 * `navigator.sendBeacon` cannot set an Authorization header. That path is
 * best-effort by nature; live-watchdog is what actually guarantees the close.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getAuthedCreatorFromToken,
  getServiceClient,
} from '../_shared/utils.ts';
import { closeLiveSession, type LiveSessionRow } from '../_shared/endLiveSession.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    const body = await req.json().catch(() => ({}));

    /**
     * The token from the Authorization header, or from the body.
     *
     * The body is the beacon path and nothing else: `navigator.sendBeacon`
     * sends a bare POST with no headers of its own, so a page being unloaded
     * has no other way to say who it is. Same credential, same TLS, same
     * origin — only the envelope differs, and it is validated identically.
     */
    const auth = await getAuthedCreatorFromToken(
      req.headers.get('Authorization'),
      typeof body.access_token === 'string' ? body.access_token : null,
    );
    if (!auth) return errorResponse('Not authenticated as creator', 401);

    if (!body.live_session_id) return errorResponse('live_session_id required', 400);

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
      // Not an error, and increasingly the NORMAL answer: a beacon fired on
      // pagehide and the creator then pressed "จบไลฟ์" on a restored tab, or
      // the watchdog got there first.
      return jsonResponse({ already_ended: true, session_id: session.id });
    }

    const result = await closeLiveSession(supabase, session as LiveSessionRow, {
      // The creator is here, pressing the button, so the broadcast stops now.
      endedAt: new Date(),
      closedBy: 'creator',
      reportedChatCount: body.chat_message_count,
    });

    return jsonResponse({
      session_id: result.sessionId,
      duration_seconds: result.durationSeconds,
      duration_minutes: Math.round(result.durationMinutes * 100) / 100,
      peak_viewers: result.peakViewers,
      chat_messages: result.chatMessages,
      tips_received_stars: result.tipStarsReceived,
      estimated_cost_thb: Math.round(result.costThb * 100) / 100,
      cost_breakdown_thb: result.costBreakdownThb,
      // See the bunnyFinal note in _shared/endLiveSession.ts — Bunny does
      // produce a VOD when recording is on, but the field naming it has not
      // been observed yet.
      vod_video_id: null,
      recording: result.recordingEnabled
        ? { status: 'processing', message: 'Bunny is converting this broadcast to a VOD' }
        : null,
    });
  } catch (err) {
    console.error('Error:', err);
    return errorResponse(err instanceof Error ? err.message : 'Unknown error', 500);
  }
});
