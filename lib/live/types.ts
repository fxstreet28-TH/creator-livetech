/**
 * Types for the live streaming screens, mirrored from the LIVE schema on
 * Supabase project hknvooaqgpufrbdxtzxf (`live_sessions`) and from the two
 * deployed Edge Functions, `live-create-session` v2 and `live-end-session` v1.
 *
 * Read these notes before changing anything — the sprint brief and the
 * deployed backend disagree in three places, and the backend wins:
 *
 *  1. `mode: 'create'` inserts the row with **status 'waiting'**, not 'live',
 *     and nothing anywhere flips it to 'live'. A feed filtered on
 *     `status = 'live'` would therefore never show a session that is actually
 *     on air. Two things follow, both deliberate: the broadcaster promotes its
 *     own row to 'live' once LiveKit is connected (see markSessionLive in
 *     ./api), and the feed query accepts both statuses anyway so a session is
 *     discoverable even if that write is refused.
 *
 *  2. `peak_viewer_count` is never written by either function.
 *     `live-end-session` READS the column to build its summary, so without a
 *     writer the "ผู้ชมสูงสุด" line of every session summary is 0. The
 *     broadcaster is the only party that knows the real number (LiveKit tells
 *     it), so it persists it — see persistViewerCounts in ./api.
 *
 *  3. `mode: 'join'` answers a locked session with 403 `access_denied` and an
 *     English sentence, and does NOT return the access_level. The lock card
 *     has to infer it from that sentence; see lockLevelFromMessage in ./api.
 *
 * AccessLevel is imported rather than redeclared: `live_sessions.access_level`
 * carries the same four values as `feed_posts.access_level`, and a second copy
 * is a second thing to get wrong the day the CHECK constraint changes.
 */

import type { AccessLevel } from '@/lib/creator/types';

export type { AccessLevel };

/** live_sessions.status CHECK. */
export type LiveStatus = 'scheduled' | 'waiting' | 'live' | 'paused' | 'ended' | 'cancelled';

/** live_sessions.broadcast_quality, and content_tier_limits.max_live_quality. */
export type BroadcastQuality = '360p' | '480p' | '720p' | '1080p';

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
   * .tus_headers in lib/creator/types.ts. A broadcast that outlives the
   * token needs a fresh one from a fresh call, not a stored copy.
   */
  access_token: string;
  /** What the backend actually granted — the tier cap, not necessarily the ask. */
  broadcast_quality: BroadcastQuality;
  max_viewers: number;
  hours_remaining_today: number;
}

/** Body of live-create-session, mode=join. */
export interface JoinLiveRequest {
  mode: 'join';
  live_session_id: string;
  display_name?: string;
}

/** 200 from live-create-session, mode=join. LiveKit JWT, 1h TTL, canPublish: false. */
export interface JoinLiveResponse {
  live_session_id: string;
  room_name: string;
  ws_url: string;
  /** SECURITY: see CreateLiveResponse.access_token. */
  access_token: string;
}

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
   * Always null this sprint: the function answers `{ status:
   * 'not_implemented' }` only when BOTH save_recording and the row's
   * recording_enabled are true, and the go-live form never sets either.
   */
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
}

/**
 * A chat line, as it travels over the LiveKit data channel.
 *
 * Ephemeral by design: nothing writes these to Postgres (non-negotiable #6),
 * so a viewer who joins late sees an empty panel and everything is lost when
 * the room closes. `sender` is what the sender claims to be called — the
 * trustworthy identity is the LiveKit participant identity, which the backend
 * mints as `creator-<id>` / `viewer-<id>`, and which is what the 👑 badge is
 * derived from.
 */
export interface LiveChatMessage {
  type: 'chat';
  text: string;
  sender: string;
  timestamp: number;
}

/** A chat line after the receiver has attributed it to a participant. */
export interface LiveChatEntry {
  /** Local, monotonic — data packets carry no id and timestamps can collide. */
  id: string;
  text: string;
  sender: string;
  timestamp: number;
  /** LiveKit participant identity, or null for our own optimistic echo. */
  identity: string | null;
  /** True when the sender's identity marks them as the room's broadcaster. */
  isCreator: boolean;
  /** True when we sent it. */
  isSelf: boolean;
}
