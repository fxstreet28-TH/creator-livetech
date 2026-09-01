/**
 * live-create-session v3 — open a broadcast.
 *
 * v2 minted a LiveKit token and stopped there, and every viewer joined the
 * same room. v3 keeps the LiveKit room for the PUBLISHER only and adds the
 * delivery half: a Bunny Live stream, and a LiveKit RoomComposite egress that
 * pushes the room into it over RTMP. Viewers never touch LiveKit again — they
 * pull LL-HLS off Bunny's CDN via live-get-playback-url.
 *
 * Bunny Live has no WHIP ingest (checked against library 740127 on
 * 2026-09-01), which is why the publisher side is still WebRTC-into-LiveKit
 * rather than the browser talking to Bunny directly. See ../_shared/live.ts.
 *
 * THREE MODES, and the third one only exists during the transition:
 *
 *   create        creator opens a session. Returns a publisher token plus
 *                 which delivery path this session got.
 *   start_egress  called once the publisher is actually connected. Starting
 *                 the egress here, rather than inside `create`, means an
 *                 abandoned go-live cannot leave an egress encoding an empty
 *                 room at $0.015/minute until somebody notices.
 *   join          UNCHANGED from v2, and deliberately still here. Production
 *                 runs the pre-migration frontend until the web PR ships, and
 *                 that frontend asks for a LiveKit viewer token on this route.
 *                 Deleting it would take live streaming down between the
 *                 backend deploy and the frontend deploy.
 *                 TODO(phase 2B): remove once the LL-HLS frontend is live and
 *                 stable, together with the rest of the LiveKit viewer path.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getAuthedUser,
  getAuthedCreator,
  getServiceClient,
  getVaultSecrets,
} from '../_shared/utils.ts';
import {
  bunnyCreateLiveStream,
  bunnyRtmpDestination,
  generateLiveKitToken,
  startRoomCompositeEgress,
} from '../_shared/live.ts';

const QUALITY_ORDER = ['360p', '480p', '720p', '1080p'];

/** Publisher tokens outlive a long broadcast; the egress token is minted per call. */
const PUBLISHER_TOKEN_TTL_SECONDS = 4 * 3600;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);
    const body = await req.json();
    const supabase = getServiceClient();

    const secrets = await getVaultSecrets([
      'livekit_ws_url',
      'livekit_api_key',
      'livekit_api_secret',
      'bunny_stream_api_key',
      'bunny_stream_library_id',
    ]);
    const {
      livekit_ws_url: wsUrl,
      livekit_api_key: livekitKey,
      livekit_api_secret: livekitSecret,
      bunny_stream_api_key: bunnyKey,
      bunny_stream_library_id: bunnyLibrary,
    } = secrets;

    // -----------------------------------------------------------------------
    // create
    // -----------------------------------------------------------------------
    if (body.mode === 'create') {
      const auth = await getAuthedCreator(req);
      if (!auth) return errorResponse('Not authenticated as creator', 401);
      if (!body.title?.trim()) return errorResponse('title required', 400);

      // The kill switch. `check_creator_can_golive` refuses at budget status
      // 'emergency' or 'readonly', on a throttled account, and over the daily
      // hour cap — all three arrive as one `quota_exceeded`, which the client
      // maps to Thai by reading the sentence.
      const { data: quotaCheck } = await supabase.rpc('check_creator_can_golive', {
        p_creator_id: auth.creatorId,
      });
      const quota = Array.isArray(quotaCheck) ? quotaCheck[0] : quotaCheck;
      if (!quota?.can_golive) {
        return errorResponse(quota?.reason ?? 'Cannot go live now', 403, 'quota_exceeded');
      }

      const { data: creatorData } = await supabase
        .from('creators')
        .select('handle')
        .eq('id', auth.creatorId)
        .single();
      const handle = creatorData?.handle ?? `creator-${auth.creatorId.slice(0, 8)}`;
      const roomName = `live-${handle}-${Date.now()}`;

      const requestedQuality = body.broadcast_quality ?? '720p';
      const finalQuality = QUALITY_ORDER[
        Math.min(QUALITY_ORDER.indexOf(requestedQuality), QUALITY_ORDER.indexOf(quota.max_quality))
      ];

      const latencyMode = ['ultra_low', 'low_latency', 'standard'].includes(body.latency_mode)
        ? body.latency_mode
        : 'low_latency';

      /**
       * Bunny is created BEFORE the row so the row is written once, complete.
       *
       * A failure here is soft on purpose. The session still works over
       * LiveKit end to end, production is still running the pre-migration
       * frontend that only knows that path, and refusing to go live because a
       * CDN we are in the middle of adopting had a bad minute would be a worse
       * trade than one expensive broadcast.
       */
      let bunny = null;
      try {
        bunny = await bunnyCreateLiveStream(
          bunnyLibrary,
          bunnyKey,
          `Live: ${handle} - ${new Date().toISOString()}`,
          {
            dvrEnabled: true,
            // Bunny cannot start recording retroactively, so this is decided
            // here or never. It follows the creator's own choice.
            recordVod: body.recording_enabled === true,
          },
        );
      } catch (err) {
        console.error('[live-create-session] Bunny live create failed, falling back to LiveKit delivery', err);
      }

      const { data: session, error: sessionErr } = await supabase
        .from('live_sessions')
        .insert({
          creator_id: auth.creatorId,
          room_name: roomName,
          title: body.title,
          description: body.description ?? null,
          cover_image_url: body.cover_image_url ?? null,
          access_level: body.access_level ?? 'public',
          ppv_price_stars: body.ppv_price_stars ?? null,
          status: 'waiting',
          started_at: new Date().toISOString(),
          broadcast_quality: finalQuality,
          recording_enabled: body.recording_enabled ?? false,
          latency_mode: latencyMode,
          bunny_stream_id: bunny?.guid ?? null,
          bunny_stream_key: bunny?.streamKey ?? null,
          bunny_ingest_url: bunny?.ingestEndpoints?.rtmp?.primaryIngestUrl ?? null,
          bunny_playback_url: bunny?.playbackUrlHls ?? null,
          bunny_thumbnail_url: bunny?.thumbnailUrl ?? null,
        })
        .select('id, room_name')
        .single();

      if (sessionErr) {
        console.error('Failed to create live session:', sessionErr);
        return errorResponse(`Failed to create session: ${sessionErr.message}`, 500);
      }

      const token = await generateLiveKitToken(
        livekitKey,
        livekitSecret,
        `creator-${auth.creatorId}`,
        handle,
        {
          room: roomName,
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
          // Still granted so a LiveKit-delivery session (the fallback above,
          // and any pre-migration client) keeps its data channel. The LL-HLS
          // path does not use it — chat and reactions moved to the Supabase
          // Realtime channel `live:<session_id>`.
          canPublishData: true,
          canUpdateOwnMetadata: true,
        },
        PUBLISHER_TOKEN_TTL_SECONDS,
      );

      return jsonResponse({
        live_session_id: session.id,
        room_name: session.room_name,
        ws_url: wsUrl,
        access_token: token,
        broadcast_quality: finalQuality,
        max_viewers: quota.max_viewers,
        hours_remaining_today: quota.hours_remaining_today,
        // SECURITY: bunny_stream_key and the RTMP URL are NOT returned. Under
        // this architecture the browser never speaks RTMP — only the egress
        // does, server side — so handing the page a publish credential would
        // be giving away something it has no use for.
        delivery: bunny ? 'llhls' : 'livekit',
        latency_mode: latencyMode,
      });
    }

    // -----------------------------------------------------------------------
    // start_egress
    // -----------------------------------------------------------------------
    if (body.mode === 'start_egress') {
      const auth = await getAuthedCreator(req);
      if (!auth) return errorResponse('Not authenticated as creator', 401);
      if (!body.live_session_id) return errorResponse('live_session_id required', 400);

      const { data: session, error: readErr } = await supabase
        .from('live_sessions')
        .select('id, creator_id, room_name, status, broadcast_quality, bunny_stream_id, bunny_stream_key, bunny_ingest_url, livekit_egress_id')
        .eq('id', body.live_session_id)
        .maybeSingle();

      if (readErr) return errorResponse(readErr.message, 500);
      if (!session) return errorResponse('Live session not found', 404);
      if (session.creator_id !== auth.creatorId) return errorResponse('Not your session', 403);
      if (session.status === 'ended' || session.status === 'cancelled') {
        return errorResponse(`Live not active (status: ${session.status})`, 409, 'not_active');
      }
      if (!session.bunny_stream_id || !session.bunny_stream_key || !session.bunny_ingest_url) {
        return errorResponse('Session has no Bunny delivery stream', 409, 'no_bunny_stream');
      }

      // Idempotent: the broadcaster retries this on reconnect, and a second
      // egress would double the bill and give Bunny two publishers.
      if (session.livekit_egress_id) {
        return jsonResponse({ egress_id: session.livekit_egress_id, already_started: true });
      }

      const rtmpUrl = bunnyRtmpDestination({
        guid: session.bunny_stream_id,
        title: '',
        streamKey: session.bunny_stream_key,
        playbackUrlHls: '',
        thumbnailUrl: null,
        ingestEndpoints: { rtmp: { primaryIngestUrl: session.bunny_ingest_url } },
      });

      let egress;
      try {
        egress = await startRoomCompositeEgress(
          wsUrl,
          livekitKey,
          livekitSecret,
          session.room_name,
          rtmpUrl,
          session.broadcast_quality ?? '720p',
        );
      } catch (err) {
        console.error('[live-create-session] start egress failed', err);
        return errorResponse('Failed to start delivery to CDN', 502, 'egress_failed');
      }

      // status is promoted here rather than from the creator's browser: this
      // is the first moment the session is genuinely watchable, and it is a
      // write the server can vouch for.
      await supabase
        .from('live_sessions')
        .update({
          livekit_egress_id: egress.egressId,
          status: 'live',
          updated_at: new Date().toISOString(),
        })
        .eq('id', session.id);

      return jsonResponse({ egress_id: egress.egressId, already_started: false });
    }

    // -----------------------------------------------------------------------
    // join — v2 behaviour, kept for the pre-migration frontend. See the header.
    // -----------------------------------------------------------------------
    if (body.mode === 'join') {
      const user = await getAuthedUser(req);
      if (!user) return errorResponse('Authentication required', 401);

      const { data: session, error: sessionErr } = await supabase
        .from('live_sessions')
        .select('id, creator_id, room_name, access_level, ppv_price_stars, status, current_viewer_count')
        .eq('id', body.live_session_id)
        .maybeSingle();

      if (sessionErr) return errorResponse(sessionErr.message, 500);
      if (!session) return errorResponse('Live session not found', 404);
      if (!['live', 'waiting'].includes(session.status)) {
        return errorResponse(`Live not active (status: ${session.status})`, 409, 'not_active');
      }

      const { data: allowed } = await supabase.rpc('can_watch_live_session', {
        p_session_id: session.id,
        p_user_id: user.id,
      });

      if (allowed !== true) {
        return errorResponse(
          session.access_level === 'ppv' ? 'Pay to unlock this live' : 'Subscribe to watch',
          403,
          'access_denied',
        );
      }

      const viewerName = body.display_name ?? user.email?.split('@')[0] ?? 'viewer';
      const token = await generateLiveKitToken(
        livekitKey,
        livekitSecret,
        `viewer-${user.id}`,
        viewerName,
        { room: session.room_name, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: true },
        3600,
      );

      await supabase
        .from('live_sessions')
        .update({
          current_viewer_count: (session.current_viewer_count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', session.id);

      return jsonResponse({
        live_session_id: session.id,
        room_name: session.room_name,
        ws_url: wsUrl,
        access_token: token,
      });
    }

    return errorResponse('Invalid mode (must be create, start_egress or join)', 400);
  } catch (err) {
    console.error('Error:', err);
    return errorResponse(err instanceof Error ? err.message : 'Unknown error', 500);
  }
});
