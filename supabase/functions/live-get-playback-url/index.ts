/**
 * live-get-playback-url v1 — what a viewer needs in order to watch.
 *
 * This is the function that replaces `live-create-session mode=join` for the
 * LL-HLS frontend, and it is deliberately the ONLY place a viewer's
 * entitlement is decided. The join function had its own copy of the
 * subscriber/PPV ladder, the RLS policies on live_sessions had another, and
 * the new Realtime channel would have been a third — so all of them now call
 * one SECURITY DEFINER function, `can_watch_live_session`, and the chat channel
 * and the video can no longer disagree about who is allowed in.
 *
 * It answers one of two deliveries:
 *
 *   llhls    the normal path. A Bunny CDN URL the browser plays with hls.js.
 *   livekit  a session with no Bunny stream — a row created before this
 *            migration, or one whose Bunny create failed and fell back. The
 *            viewer gets a subscriber token instead, so those sessions keep
 *            playing instead of showing an error for something that is not the
 *            viewer's problem.
 *            TODO(phase 2B): drop with the rest of the LiveKit viewer path.
 *
 * verify_jwt is on, so the login gate is enforced at the gateway before any of
 * this runs; `getAuthedUser` returning null here means a malformed or expired
 * token got past it.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getAuthedUser,
  getServiceClient,
  getVaultSecrets,
  tryGetVaultSecret,
} from '../_shared/utils.ts';
import { generateLiveKitToken, signBunnyUrl } from '../_shared/live.ts';

/**
 * How long a playback URL stays valid.
 *
 * An hour, and the client refreshes rather than holding one for the length of
 * a broadcast: a URL that outlives the session it belongs to is a URL that can
 * be passed around after the creator has stopped consenting to it. Only
 * meaningful once the pull zone has token authentication on — see signBunnyUrl.
 */
const PLAYBACK_TTL_SECONDS = 3600;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    const user = await getAuthedUser(req);
    if (!user) return errorResponse('Authentication required', 401);

    const body = await req.json();
    if (!body.session_id) return errorResponse('session_id required', 400);

    const supabase = getServiceClient();

    // The platform kill switch. `emergency` is the only status that stops an
    // audience mid-broadcast — 'degraded' blocks new broadcasts from STARTING
    // (that check lives in check_creator_can_golive) but throwing existing
    // viewers out of a live that is already running costs more goodwill than
    // the bandwidth saves.
    const { data: budget } = await supabase
      .from('platform_budget_state')
      .select('status')
      .eq('month_key', await currentMonthKey(supabase))
      .maybeSingle();

    if (budget?.status === 'emergency' || budget?.status === 'readonly') {
      return errorResponse(
        'Live streaming is temporarily unavailable',
        503,
        'platform_unavailable',
      );
    }

    const { data: session, error: sessionErr } = await supabase
      .from('live_sessions')
      .select('id, creator_id, room_name, title, status, ended_at, latency_mode, bunny_stream_id, bunny_playback_url, bunny_thumbnail_url, access_level')
      .eq('id', body.session_id)
      .maybeSingle();

    if (sessionErr) return errorResponse(sessionErr.message, 500);
    if (!session) return errorResponse('Live session not found', 404);
    if (session.ended_at !== null || ['ended', 'cancelled'].includes(session.status)) {
      return errorResponse(`Live not active (status: ${session.status})`, 409, 'not_active');
    }

    const { data: allowed, error: accessErr } = await supabase.rpc('can_watch_live_session', {
      p_session_id: session.id,
      p_user_id: user.id,
    });
    if (accessErr) return errorResponse(accessErr.message, 500);

    if (allowed !== true) {
      return errorResponse(
        session.access_level === 'ppv' ? 'Pay to unlock this live' : 'Subscribe to watch',
        403,
        'access_denied',
      );
    }

    /**
     * Which user id owns this broadcast.
     *
     * The client needs it to decide whose chat lines get the 👑. Under LiveKit
     * that badge came from a server-asserted participant identity; on a
     * Realtime broadcast channel the sender writes their own payload, so the
     * client compares the claimed id against this one instead of trusting a
     * flag in the message.
     *
     * SECURITY: this is a bearer-of-nothing UUID — every table is behind RLS
     * keyed on auth.uid(), not on knowing an id — but it IS still an
     * impersonation ceiling rather than a wall: a viewer who has seen the
     * creator's messages can replay that id. Chat is ephemeral and unmoderated
     * either way.
     * TODO(post-launch): sign chat lines, or route them through this function.
     */
    const { data: creator } = await supabase
      .from('creators')
      .select('user_id')
      .eq('id', session.creator_id)
      .maybeSingle();

    const secrets = await getVaultSecrets([
      'livekit_ws_url',
      'livekit_api_key',
      'livekit_api_secret',
    ]);

    // ---- Legacy / fallback delivery ---------------------------------------
    if (!session.bunny_playback_url) {
      const token = await generateLiveKitToken(
        secrets.livekit_api_key,
        secrets.livekit_api_secret,
        `viewer-${user.id}`,
        user.email?.split('@')[0] ?? 'viewer',
        { room: session.room_name, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: true },
        PLAYBACK_TTL_SECONDS,
      );

      return jsonResponse({
        delivery: 'livekit',
        session_id: session.id,
        ws_url: secrets.livekit_ws_url,
        access_token: token,
        creator_user_id: creator?.user_id ?? null,
        latency_mode: session.latency_mode ?? 'low_latency',
        expires_at: new Date(Date.now() + PLAYBACK_TTL_SECONDS * 1000).toISOString(),
      });
    }

    // ---- LL-HLS -----------------------------------------------------------
    const expiresAtUnix = Math.floor(Date.now() / 1000) + PLAYBACK_TTL_SECONDS;
    const tokenKey = await tryGetVaultSecret('bunny_stream_token_key');
    const playbackUrl = await signBunnyUrl(session.bunny_playback_url, tokenKey, expiresAtUnix);

    // NO VIEWER COUNTING HERE. An increment on this call could only ever go
    // up — an HLS viewer closing a tab tells the server nothing — so it would
    // report a session's peak as its total number of arrivals, and that peak
    // is what live-end-session prices the broadcast from. The count comes from
    // Realtime presence on the `live:<session_id>` channel instead, which
    // drops a viewer when their socket does; the broadcaster writes it back
    // via set_live_viewer_counts.

    return jsonResponse({
      delivery: 'llhls',
      session_id: session.id,
      playback_url: playbackUrl,
      thumbnail_url: session.bunny_thumbnail_url,
      latency_mode: session.latency_mode ?? 'low_latency',
      creator_user_id: creator?.user_id ?? null,
      expires_at: new Date(expiresAtUnix * 1000).toISOString(),
      // False whenever the pull zone has no token key yet: the URL is then a
      // plain CDN link and the login gate above is the only thing protecting
      // it. Surfaced so this is visible in a response rather than only in a
      // vault listing.
      signed: tokenKey !== null,
    });
  } catch (err) {
    console.error('Error:', err);
    return errorResponse(err instanceof Error ? err.message : 'Unknown error', 500);
  }
});

/** Bangkok's month, which is what every budget row is keyed on. */
async function currentMonthKey(supabase: ReturnType<typeof getServiceClient>): Promise<string> {
  const { data } = await supabase.rpc('current_month_key');
  if (typeof data === 'string' && data !== '') return data;
  return new Date()
    .toLocaleString('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' })
    .replace(/(\d{4})-(\d{2}).*/, '$1-$2');
}
