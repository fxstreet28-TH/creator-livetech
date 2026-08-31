/**
 * Types for the viewer-side screens: /discover, /posts/[id], /c/[handle], and
 * the dashboard sections that reuse them.
 *
 * The enum-ish column types are re-exported from lib/creator/types rather than
 * redeclared. They describe the same CHECK constraints on the same table, and
 * a second copy is a second thing to get wrong the day a constraint changes.
 *
 * What is new here is the *shape* the viewer reads, which differs from
 * CreatorPost in two ways:
 *
 *  - it carries a resolved `creator` summary, because a card has to name who
 *    made the video, and
 *  - it drops the columns only the owner cares about (publish_status,
 *    file_size_bytes, comment_count), which non-owners cannot always read.
 */

import type { AccessLevel, PostType, VideoStatus } from '@/lib/creator/types';

export type { AccessLevel, PostType, VideoStatus };

/**
 * Who made a post, as a viewer sees them.
 *
 * Every field is nullable, and that is not defensive padding — it is the live
 * state of the database. `creators.handle` / `display_name` / `category` are
 * NULL on every row today (the apply flow does not write them yet), and
 * `creator_profiles` is empty, so a card must render without any of them.
 * See resolveCreatorSummary() in ./publicFeed for where each field comes from.
 */
export interface CreatorSummary {
  /** creators.id — the value feed_posts.creator_id points at. */
  id: string;
  handle: string | null;
  display_name: string | null;
  category: string | null;
  avatar_url: string | null;
}

/** One published post as the viewer screens read it. */
export interface PublicPost {
  id: string;
  creator_id: string;
  creator: CreatorSummary;
  title: string | null;
  /** The description. Named `content` in the schema. */
  content: string | null;
  post_type: PostType;
  access_level: AccessLevel;
  ppv_post_id: string | null;
  /** From the ppv_posts embed. Null unless this is a PPV post with a price. */
  ppv_price_stars: number | null;
  video_uid: string | null;
  video_status: VideoStatus | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  /** '16:9' | '9:16' | '1:1' in practice; free text in the DB. */
  aspect_ratio: string | null;
  view_count: number;
  like_count: number;
  tip_stars_received: number;
  published_at: string | null;
  created_at: string;
}

/** One row of live_sessions, for the dashboard's "กำลังไลฟ์ตอนนี้" strip. */
export interface LiveSessionSummary {
  id: string;
  creator_id: string;
  creator: CreatorSummary;
  room_name: string;
  title: string;
  current_viewer_count: number;
  cover_image_url: string | null;
  access_level: AccessLevel;
}

/** A creator's public profile, for /c/[handle]. */
export interface PublicCreatorProfile {
  creator_id: string;
  handle: string | null;
  display_name: string | null;
  category: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  total_subscribers: number;
  total_followers: number;
}

/** One active plan a creator offers, shown on the subscribers lock card. */
export interface SubscriptionPlanSummary {
  id: string;
  name: string;
  description: string | null;
  price_stars: number | null;
  price_thb: number;
  benefits: string[];
}

/** 200 from content-get-playback-url — the caller is entitled. */
export interface PlaybackAllowed {
  has_access: true;
  access_reason: 'creator_own' | 'public' | 'free_preview' | 'subscriber' | 'ppv_unlocked';
  post_id: string;
  title: string | null;
  /** HLS manifest (.m3u8). */
  playback_url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
}

/**
 * 403 from content-get-playback-url — published, encoded, but not for this
 * viewer. Note that this is NOT the function's error envelope: it is a plain
 * body carrying enough metadata to render a preview behind the lock, which is
 * the only way the viewer screens can show a locked post at all (see the RLS
 * note in ./publicFeed).
 */
export interface PlaybackDenied {
  has_access: false;
  access_level: AccessLevel;
  title: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  /** English, from the backend. Never rendered — the UI maps access_level. */
  message: string;
}

/** Anything that stopped the call before it could answer either way. */
export interface PlaybackFailure {
  /** Backend code, or a local pseudo-code ('unauthenticated', 'network_error'). */
  code: string;
  /** Thai, renderable. */
  message: string;
  /** HTTP status; absent when the request never landed. */
  status?: number;
}

/**
 * The three outcomes /posts/[id] branches on. A discriminated union rather
 * than `{ data, error }` because "denied" is a successful, expected answer
 * that renders its own screen — collapsing it into `error` is what makes a
 * paywall look like a crash.
 */
export type PlaybackResult =
  | { kind: 'allowed'; playback: PlaybackAllowed }
  | { kind: 'denied'; playback: PlaybackDenied }
  | { kind: 'error'; error: PlaybackFailure };
