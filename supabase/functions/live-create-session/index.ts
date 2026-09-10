/**
 * live-create-session v3 — open a broadcast.
 *
 * The creator publishes WebRTC into a LiveKit room. Where the VIEWERS get the
 * video from is the part that moves: either LL-HLS off Bunny's CDN (cheap, and
 * what this migration is for) or a direct subscription to the same LiveKit
 * room (the pre-migration path, ~8x dearer per viewer).
 *
 * Bunny Live has no WHIP ingest (checked against library 740127 on
 * 2026-09-01), which is why the publisher side is WebRTC-into-LiveKit either
 * way rather than the browser talking to Bunny directly. See ../_shared/live.ts.
 *
 * DELIVERY IS A RUNTIME SWITCH, not a build-time one. The vault secret
 * `live_delivery_mode` decides which of the three a session gets, and it is
 * read on every create. Flipping it needs no deploy, which is the whole point:
 * on 2026-09-01 Bunny was accepting the RTMP feed (it parsed the video header —
 * width, height and framerate came back populated) and then never
 * transitioning the stream to live or producing a playlist, so every LL-HLS
 * viewer waited on a manifest that was never written. Until that is fixed on
 * Bunny's side, 'livekit' is the mode that actually delivers video.
 *
 * THE THIRD MODE, 'origin', added 2026-09-07. The creator publishes WHIP
 * straight into our own MediaMTX on origin-sg-1, which produces LL-HLS itself
 * and is cached by a Bunny Standard Pull Zone. LiveKit and Bunny Live are both
 * out of the path — there is no room, no token and no egress, which is why the
 * origin branch returns before any of those are minted.
 *
 * THE FOURTH MODE, 'livekit_selfhost', added 2026-09-10. Byte for byte the
 * 'livekit' path — same room, same token shape, same WebRTC subscribe — pointed
 * at our own LiveKit on livekit-sg-1 instead of LiveKit Cloud. ONLY THE VAULT
 * NAMES DIFFER (see livekitVaultNamesFor), which is deliberate: the whole point
 * of the migration is to escape Cloud's $0.12/GB egress without the frontend
 * learning a new delivery path, so `delivery` still answers 'livekit' and
 * LiveKitLivePlayer cannot tell the two apart.
 *
 * WHICH MODE A SESSION GOT IS WRITTEN ONTO THE ROW, in
 * `metadata.delivery_mode`. Nothing else on the row can say: a self-hosted
 * session has no `origin_room_id` and no `bunny_stream_id`, so the derivation
 * live-end-session used to run scored it as 'llhls' and billed it for a CDN it
 * never touched. See deliveryModeFor in ../_shared/endLiveSession.ts.
 *
 * It is also the only mode with a HARD CEILING. LiveKit and Bunny absorb load
 * by billing for it; origin-sg-1 is one 2 vCPU box, so admission is capped at
 * `origin_concurrent_live_cap` broadcasts. See the cap check in `create` —
 * it is deliberately scoped to this mode and does not exist for the other two.
 *
 * THREE REQUEST MODES (not to be confused with the delivery modes above):
 *
 *   create        creator opens a session. Returns a publisher token plus
 *                 which delivery path this session got.
 *   start_egress  called once the publisher is actually connected. Starting
 *                 the egress here, rather than inside `create`, means an
 *                 abandoned go-live cannot leave an egress encoding an empty
 *                 room at $0.015/minute until somebody notices. Never reached
 *                 in 'livekit' mode — there is no Bunny stream to push to.
 *   join          UNCHANGED from v2, and deliberately still here. Production
 *                 runs the pre-migration frontend until the web PR ships, and
 *                 that frontend asks for a LiveKit viewer token on this route.
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
  tryGetVaultSecret,
} from '../_shared/utils.ts';
import {
  bunnyCreateLiveStream,
  bunnyRtmpDestination,
  generateLiveKitToken,
  livekitVaultNamesFor,
  resolveLiveKitCreds,
  startRoomCompositeEgress,
  stopEgress,
} from '../_shared/live.ts';

const QUALITY_ORDER = ['360p', '480p', '720p', '1080p'];

/**
 * Which pipeline carries video to viewers when the vault says nothing.
 *
 * 'livekit' — the pre-migration path, ~2.26 THB/viewer-hour, and the one that
 * is known to put a picture on a viewer's screen. LL-HLS is ~8x cheaper and is
 * what this migration is for, but a default that costs money is better than a
 * default that shows nothing, so the cheap path has to be opted INTO by
 * setting `live_delivery_mode` to 'llhls'.
 */
const DEFAULT_DELIVERY_MODE = 'livekit';

/** Publisher tokens outlive a long broadcast; the egress token is minted per call. */
const PUBLISHER_TOKEN_TTL_SECONDS = 4 * 3600;

/**
 * Capacity to assume when `origin_concurrent_live_cap` is missing or unreadable.
 *
 * Deliberately the same 12 the vault holds rather than something permissive:
 * the failure this guards is a vault read returning nothing, and answering that
 * by admitting unlimited broadcasts onto a 2 vCPU box turns a config problem
 * into an outage for everyone already on air.
 */
const DEFAULT_ORIGIN_CAP = 12;

/**
 * Random tail on a MediaMTX path, so the path is not guessable from the session
 * id alone.
 *
 * The session id is visible to every viewer of a broadcast (it is in the watch
 * URL). The WHIP publish path must not be derivable from it: MediaMTX decides
 * who may publish purely by who reaches the path first, so a guessable path is
 * a stranger publishing into a creator's session. Eight characters of
 * crypto-random on top of the id is what makes the path unguessable while
 * keeping it traceable back to a row.
 */
function randomPathSuffix(length = 8): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}


Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);
    const body = await req.json();
    const supabase = getServiceClient();

    /**
     * Read BEFORE the vault fetch, not inside the `create` branch as it was.
     *
     * The mode decides WHICH secrets to ask for — see livekitVaultNamesFor —
     * so it cannot be resolved after them. It is also needed by `start_egress`
     * and `join`, which mint tokens of their own and would otherwise sign a
     * self-hosted room's credentials with LiveKit Cloud's secret.
     */
    const deliveryMode =
      (await tryGetVaultSecret('live_delivery_mode')) ?? DEFAULT_DELIVERY_MODE;

    const secrets = await getVaultSecrets([
      ...livekitVaultNamesFor(deliveryMode),
      'bunny_stream_api_key',
      'bunny_stream_library_id',
    ]);
    const {
      wsUrl,
      apiKey: livekitKey,
      apiSecret: livekitSecret,
    } = resolveLiveKitCreds(deliveryMode, secrets);
    const bunnyKey = secrets.bunny_stream_api_key;
    const bunnyLibrary = secrets.bunny_stream_library_id;

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

      /**
       * ADMISSION CONTROL — origin mode only.
       *
       * SCOPED TO 'origin' ON PURPOSE, and this is the important part. The two
       * hosted pipelines have no fixed ceiling: LiveKit and Bunny take as many
       * concurrent broadcasts as we are willing to pay for, and the spend side
       * of that is already governed by `check_creator_can_golive` above (the
       * platform budget kill switch). Applying a 12-broadcast cap to them would
       * be a brand-new refusal on a path that has never had one — including on
       * production, which runs 'livekit' today. origin-sg-1 is different in
       * kind: 2 vCPU and 4 GB remuxing every stream on one box, where the 13th
       * broadcast does not cost more money, it degrades the twelve already on
       * air.
       *
       * `count_active_live_sessions` counts sessions holding a slot RIGHT NOW —
       * open, and either beating inside the watchdog grace period or too new to
       * have beaten yet. See the migration for why neither `status = 'live'`
       * nor `status IN ('live','waiting')` is the right question.
       */
      if (deliveryMode === 'origin') {
        const capStr = await tryGetVaultSecret('origin_concurrent_live_cap');
        const parsedCap = Number.parseInt(capStr ?? '', 10);
        const cap = Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : DEFAULT_ORIGIN_CAP;

        const { data: activeCount, error: countErr } = await supabase.rpc(
          'count_active_live_sessions',
        );

        // FAIL CLOSED. An unreadable count is not evidence there is room — and
        // the cost of guessing wrong is every live broadcast on the box
        // stuttering at once, which is worse than one creator retrying.
        if (countErr) {
          console.error('[live-create-session] active session count failed', countErr);
          return errorResponse(
            'ระบบกำลังใช้งานหนาแน่น กรุณาลองใหม่อีกครั้งใน 1-2 นาที',
            503,
            'capacity_unknown',
          );
        }

        if ((activeCount ?? 0) >= cap) {
          console.warn('[live-create-session] origin capacity full', { activeCount, cap });
          return errorResponse(
            `ระบบกำลังใช้งานเต็มความจุ (${cap} ไลฟ์พร้อมกัน) กรุณารอ 5-10 นาที`,
            503,
            'live_capacity_full',
          );
        }
      }

      /**
       * LiveKit delivery keeps the viewer on WebRTC, so there is no CDN in the
       * path and the latency is sub-second — which is what 'ultra_low' means
       * to the player. Under either HLS pipeline the creator's own choice
       * governs: 'origin' is LL-HLS the same as 'llhls' is, so it reads the
       * request rather than being pinned to a number that describes WebRTC.
       *
       * BOTH LiveKit modes are 'ultra_low': self-hosting changes who runs the
       * SFU, not what a WebRTC subscribe feels like.
       */
      const requestedLatency = ['ultra_low', 'low_latency', 'standard'].includes(body.latency_mode)
        ? body.latency_mode
        : 'low_latency';
      const latencyMode =
        deliveryMode === 'livekit' || deliveryMode === 'livekit_selfhost'
          ? 'ultra_low'
          : requestedLatency;

      /**
       * Bunny is created BEFORE the row so the row is written once, complete.
       *
       * Skipped entirely in 'livekit' mode: a Bunny stream nobody plays is an
       * object to create, track and delete for nothing, and creating one would
       * make the row claim a delivery path it is not using.
       *
       * When it IS attempted, a failure is soft on purpose — the session still
       * works over LiveKit end to end, and refusing to go live because a CDN we
       * are in the middle of adopting had a bad minute would be a worse trade
       * than one expensive broadcast. The row records which path it got, so a
       * fallback is visible rather than silent.
       */
      let bunny = null;
      if (deliveryMode === 'llhls') {
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
          console.error(
            '[live-create-session] Bunny live create failed, falling back to LiveKit delivery',
            err,
          );
        }
      }

      /**
       * The origin endpoints, resolved once, here, and then stored on the row.
       *
       * The id is minted CLIENT-SIDE rather than read back from the insert so
       * that `origin_room_id` can contain it and the row can still be written
       * once, complete — the same reason the Bunny stream above is created
       * before the insert rather than patched in afterwards. An insert followed
       * by an update would leave a window in which a session exists with no
       * endpoints, which is exactly the state a viewer arriving early would
       * read.
       *
       * Both URLs are built from vault bases and stored verbatim, so a session
       * keeps the endpoints it was opened against even if the bases later move.
       * See the migration header.
       */
      const sessionId = crypto.randomUUID();
      let originRoomId: string | null = null;
      let whipPublishUrl: string | null = null;
      let hlsPlaybackUrl: string | null = null;

      if (deliveryMode === 'origin') {
        const originSecrets = await getVaultSecrets([
          'origin_whip_endpoint_base',
          'origin_hls_endpoint_base',
        ]);
        const whipBase = originSecrets.origin_whip_endpoint_base;
        const hlsBase = originSecrets.origin_hls_endpoint_base;

        // Unlike the Bunny failure above, this one is HARD. A soft fallback
        // there still produced a session that played over LiveKit; here there
        // is nothing to fall back to — a row with no WHIP URL is a creator
        // with nowhere to publish, and going live to nowhere is worse than
        // being told to try again.
        if (!whipBase || !hlsBase) {
          console.error('[live-create-session] origin endpoint bases missing from vault');
          return errorResponse('ระบบไลฟ์ยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง', 503, 'origin_unconfigured');
        }

        originRoomId = `${sessionId}-${randomPathSuffix()}`;
        whipPublishUrl = `${whipBase}${originRoomId}`;
        hlsPlaybackUrl = `${hlsBase}${originRoomId}/index.m3u8`;
      }

      const { data: session, error: sessionErr } = await supabase
        .from('live_sessions')
        .insert({
          id: sessionId,
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
          origin_room_id: originRoomId,
          whip_publish_url: whipPublishUrl,
          hls_playback_url: hlsPlaybackUrl,
          /**
           * The pipeline this session is being opened on, recorded at the one
           * moment it is known for certain.
           *
           * WRITTEN HERE RATHER THAN DERIVED LATER because it cannot be derived
           * later: 'livekit' and 'livekit_selfhost' leave identical rows —
           * neither has an origin room nor a Bunny stream — and the vault
           * secret that chose between them describes whatever the NEXT session
           * will get by the time anyone reads it back. live-end-session prices
           * the session off this field; see deliveryModeFor.
           *
           * The whole `metadata` object is set rather than merged because this
           * is an INSERT: there is nothing yet to merge with, and closeLiveSession
           * spreads the stored object when it adds its own keys later.
           */
          metadata: { delivery_mode: deliveryMode },
        })
        .select('id, room_name')
        .single();

      if (sessionErr) {
        console.error('Failed to create live session:', sessionErr);
        return errorResponse(`Failed to create session: ${sessionErr.message}`, 500);
      }

      /**
       * Origin sessions return HERE, before any LiveKit token is minted.
       *
       * Not an optimisation. A publisher token is a credential for a room, and
       * an origin broadcast has no room — issuing one anyway would hand the
       * page a live LiveKit credential it has no use for, and bill us for a
       * participant nobody is watching if it ever connected. The creator's
       * authorisation to publish is the auth on THIS call plus the unguessable
       * WHIP path; see randomPathSuffix.
       *
       * `hls_url` is returned alongside so the studio can show the creator
       * where their broadcast will appear. Viewers do NOT get it from here —
       * they go through live-get-playback-url, which is the one place the
       * entitlement ladder is evaluated.
       */
      if (deliveryMode === 'origin') {
        return jsonResponse({
          live_session_id: session.id,
          room_name: session.room_name,
          delivery: 'origin',
          whip_url: whipPublishUrl,
          hls_url: hlsPlaybackUrl,
          origin_room_id: originRoomId,
          broadcast_quality: finalQuality,
          max_viewers: quota.max_viewers,
          hours_remaining_today: quota.hours_remaining_today,
          latency_mode: latencyMode,
        });
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
        //
        // 'livekit' COVERS BOTH LiveKit modes, and that is the contract rather
        // than a shortcut: `ws_url` and `access_token` above already point at
        // whichever deployment was chosen, so the page has everything it needs
        // and a fifth value here would only give the frontend a distinction it
        // has no code for. The row remembers the difference — see the metadata
        // note on the insert — which is where the difference actually matters.
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
      //
      // The error IS checked, unlike most best-effort writes in this codebase,
      // because this row is the only record of a running egress. When it does
      // not land, live-end-session has nothing to stop and the egress bills
      // until LiveKit reaps the empty room. Answering 200 to a caller whose
      // egress we have just lost track of is how that goes unnoticed — which
      // is exactly what happened on 2026-09-01, when the id was read off the
      // wrong casing and silently written as undefined.
      const { error: persistErr } = await supabase
        .from('live_sessions')
        .update({
          livekit_egress_id: egress.egressId,
          status: 'live',
          updated_at: new Date().toISOString(),
        })
        .eq('id', session.id);

      if (persistErr) {
        console.error('[live-create-session] egress started but id not persisted', {
          egress_id: egress.egressId,
          session_id: session.id,
          error: persistErr.message,
        });
        // Stop what we cannot track, rather than leave it running unnamed.
        await stopEgress(wsUrl, livekitKey, livekitSecret, egress.egressId);
        return errorResponse('Failed to record delivery stream', 500, 'egress_not_persisted');
      }

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
