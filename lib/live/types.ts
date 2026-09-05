/**
 * Types for the live streaming screens, mirrored from the LIVE schema on
 * Supabase project hknvooaqgpufrbdxtzxf (`live_sessions`) and from the three
 * deployed Edge Functions: `live-create-session` v3, `live-end-session` v2 and
 * `live-get-playback-url` v1.
 *
 * ARCHITECTURE, because these types only make sense against it:
 *
 *   creator's browser --WebRTC--> LiveKit room --RoomComposite egress--> RTMP
 *     --> Bunny Live --transcode--> LL-HLS on the CDN --> every viewer
 *
 * The creator is still a LiveKit publisher (Bunny Live has no WHIP ingest, and
 * a browser cannot speak RTMP). Viewers are not LiveKit participants any more
 * — they are HTTP requests to a CDN, which is where the 8x cost reduction
 * comes from. Chat and reactions therefore no longer have a room to travel
 * through and live on a Supabase Realtime channel instead; see ./realtime.ts.
 *
 * Three notes on the backend that still apply, and one that no longer does:
 *
 *  1. `mode: 'create'` still inserts the row with status 'waiting'. What
 *     promotes it to 'live' has changed for the better: `mode: 'start_egress'`
 *     does it server-side, at the moment delivery actually starts. The
 *     broadcaster's own best-effort write (markSessionLive) is kept as a
 *     backstop for a session delivered over LiveKit, where no egress starts.
 *
 *  2. `peak_viewer_count` is still not written by the create/end functions.
 *     live-end-session READS it to build the summary AND to price the
 *     broadcast, and the broadcaster is still its only writer — but the number
 *     it writes now comes from Realtime presence rather than from the LiveKit
 *     room, because viewers are no longer in one.
 *
 *  3. A locked session still answers 403 `access_denied` with an English
 *     sentence and no access_level, so lockLevelFromMessage is still needed.
 *
 *  4. NO LONGER TRUE: the old note about `mode: 'join'` being how a viewer
 *     gets in. Viewers go through live-get-playback-url, which is the single
 *     place entitlement is decided. `join` is still deployed only so the
 *     pre-migration production frontend keeps working until this ships.
 *
 * AccessLevel is imported rather than redeclared: `live_sessions.access_level`
 * carries the same four values as `feed_posts.access_level`, and a second copy
 * is a second thing to get wrong the day the CHECK constraint changes.
 */

import type { AccessLevel } from '@/lib/creator/types';
import type { GiftRarity } from './gifts';

export type { AccessLevel };

/** live_sessions.status CHECK. */
export type LiveStatus = 'scheduled' | 'waiting' | 'live' | 'paused' | 'ended' | 'cancelled';

/** live_sessions.broadcast_quality, and content_tier_limits.max_live_quality. */
export type BroadcastQuality = '360p' | '480p' | '720p' | '1080p';

/**
 * live_sessions.latency_mode — how close to the live edge the player sits.
 *
 * Not the same thing as broadcast_quality: quality is what the camera
 * captures and what the CDN transcodes, latency is how much buffer the viewer
 * keeps. See hlsConfigFor in ./hlsPlayer.ts for what each one does.
 */
export type LatencyMode = 'ultra_low' | 'low_latency' | 'standard';

/**
 * Which pipeline is carrying a session's video.
 *
 * 'llhls' is the destination architecture. 'livekit' is a session with no
 * Bunny stream — one created before this migration, or one whose Bunny create
 * failed and fell back — and it exists so those sessions keep playing rather
 * than showing an error for something that is not the viewer's problem.
 * TODO(phase 2B): remove with the rest of the LiveKit viewer path.
 */
export type LiveDelivery = 'llhls' | 'livekit';

/** The subset of access levels the go-live form can set. */
export type LiveVisibility = Extract<AccessLevel, 'public' | 'subscribers' | 'ppv'>;

/** Body of live-create-session, mode=create. */
export interface CreateLiveRequest {
  mode: 'create';
  title: string;
  description?: string;
  cover_image_url?: string;
  access_level?: AccessLevel;
  ppv_price_stars?: number;
  broadcast_quality?: BroadcastQuality;
  latency_mode?: LatencyMode;
  recording_enabled?: boolean;
}

/** 200 from live-create-session, mode=create. */
export interface CreateLiveResponse {
  live_session_id: string;
  room_name: string;
  ws_url: string;
  /**
   * LiveKit JWT, 4h TTL, canPublish: true.
   *
   * SECURITY: this is a credential for the room. Never log it, never put it in
   * a URL, never persist it — same contract as UploadRequestResponse
   * .upload_headers in lib/creator/types.ts. A broadcast that outlives the
   * token needs a fresh one from a fresh call, not a stored copy.
   *
   * The Bunny stream key is deliberately NOT part of this response: under this
   * architecture the browser never speaks RTMP, so it has no use for a publish
   * credential and is not given one.
   */
  access_token: string;
  /** What the backend actually granted — the tier cap, not necessarily the ask. */
  broadcast_quality: BroadcastQuality;
  max_viewers: number;
  hours_remaining_today: number;
  delivery: LiveDelivery;
  latency_mode: LatencyMode;
}

/** 200 from live-create-session, mode=start_egress. */
export interface StartEgressResponse {
  egress_id: string;
  /** True when an egress was already running — the call is idempotent. */
  already_started: boolean;
}

/**
 * 200 from live-get-playback-url.
 *
 * A discriminated union rather than a bag of optional fields: the two
 * deliveries need completely different things, and `playback_url` being
 * undefined on a LiveKit session is exactly the kind of shape that gets
 * rendered as `undefined` in a <video src>.
 */
export type LivePlaybackResponse =
  | {
      delivery: 'llhls';
      session_id: string;
      /** A Bunny CDN LL-HLS playlist. Signed only once the pull zone has a token key. */
      playback_url: string;
      thumbnail_url: string | null;
      latency_mode: LatencyMode;
      /** Whose chat lines get the 👑. See ./realtime.ts for why this is needed. */
      creator_user_id: string | null;
      expires_at: string;
      /** False while the pull zone has no token key — the login gate is then the only guard. */
      signed: boolean;
    }
  | {
      delivery: 'livekit';
      session_id: string;
      ws_url: string;
      /** SECURITY: a LiveKit room credential. See CreateLiveResponse.access_token. */
      access_token: string;
      creator_user_id: string | null;
      latency_mode: LatencyMode;
      expires_at: string;
    };

/** 200 from live-end-session. */
export interface EndLiveResponse {
  session_id: string;
  duration_seconds: number;
  duration_minutes: number;
  peak_viewers: number;
  chat_messages: number;
  tips_received_stars: number;
  estimated_cost_thb: number;
  /**
   * The point of the migration, as two numbers.
   *
   * `livekit` is flat per stream-minute now (one publisher plus one egress);
   * `bunny_cdn` is the cheap per-viewer-minute line. Before the migration the
   * whole bill scaled with viewers at 10x this rate.
   */
  cost_breakdown_thb?: { livekit: number; bunny_cdn: number };
  /**
   * Null until the Bunny field naming a finished live's VOD asset is known —
   * live-end-session snapshots Bunny's final response into
   * `live_sessions.metadata.bunny_final` so the first recorded broadcast tells
   * us rather than us guessing now.
   */
  vod_video_id: string | null;
  recording: null | { status: string; message: string };
  /** Present instead of the rest when the session was already ended. */
  already_ended?: boolean;
}

/**
 * What `check_creator_can_golive` answers. SECURITY DEFINER and granted to
 * `authenticated`, so the setup form reads it directly rather than discovering
 * the creator's ceiling from a rejected go-live.
 */
export interface LiveQuota {
  canGolive: boolean;
  /** English, from Postgres. Mapped to Thai for the screen, never rendered raw. */
  reason: string | null;
  maxQuality: BroadcastQuality;
  maxViewers: number;
  hoursRemainingToday: number;
}

/**
 * One `live_sessions` row as the watch page reads it.
 *
 * Distinct from LiveSessionSummary in lib/viewer/types.ts, which is the card
 * shape for /discover and the dashboard strip: this one carries the fields a
 * watch page needs (status, description, price, quality) and that a card does
 * not.
 */
export interface LiveSessionDetail {
  id: string;
  creator_id: string;
  room_name: string;
  title: string;
  description: string | null;
  cover_image_url: string | null;
  access_level: AccessLevel;
  ppv_price_stars: number | null;
  status: LiveStatus;
  current_viewer_count: number;
  peak_viewer_count: number;
  tip_stars_received: number;
  started_at: string | null;
  ended_at: string | null;
  broadcast_quality: BroadcastQuality | null;
  latency_mode: LatencyMode | null;
}

/**
 * A chat line after the receiver has attributed it to a sender.
 *
 * Ephemeral by design: nothing writes these to Postgres, so a viewer who joins
 * late sees an empty panel and everything is lost when the tab closes. That
 * was true on the LiveKit data channel and it is still true on the Supabase
 * Realtime channel that replaced it.
 *
 * `isCreator` is now a WEAKER claim than it was. LiveKit asserted participant
 * identity server-side; a Realtime broadcast payload is written by its sender,
 * so the badge is granted by comparing the claimed `senderId` against the
 * creator id that live-get-playback-url returned. See ./realtime.ts.
 */
export interface LiveChatEntry {
  /** Local, monotonic — payloads carry no id and timestamps can collide. */
  id: string;
  text: string;
  sender: string;
  timestamp: number;
  /** The sender's claimed auth user id, or null for our own optimistic echo. */
  senderId: string | null;
  /** True when the sender's claimed id matches the session's creator. */
  isCreator: boolean;
  /** True when we sent it. */
  isSelf: boolean;
  /**
   * Set on the system line a gift writes, to the tier's rarity.
   *
   * A gift line is not chat — nobody typed it, and it is tinted rather than
   * bubbled — but it belongs in the same list because it happened at the same
   * moment as everything around it, and a separate feed beside the chat would
   * have to be scrolled separately to read one conversation. Absent on a real
   * chat line, which is how LiveChat tells them apart.
   */
  giftRarity?: GiftRarity;
}
