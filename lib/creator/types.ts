/**
 * Types for the creator content system, mirrored from the LIVE schema on
 * Supabase project hknvooaqgpufrbdxtzxf (`feed_posts` + the 15 video/live
 * columns) and from the deployed `content-*` Edge Functions.
 *
 * Read the column names carefully before changing them — the sprint brief and
 * the deployed backend disagree in several places, and the backend wins:
 *
 *   brief                    live schema
 *   ----------------------   -----------------------------------------
 *   description              content
 *   visibility               access_level
 *   'subscribers'            'subscribers'   (the phase-1 migration in this
 *                            repo still says 'subscriber_only'; the live
 *                            CHECK constraint does not)
 *   video_duration_sec       duration_seconds
 *   ppv_price_stars          — no such column; PPV pricing lives on
 *                            ppv_posts.price_stars via feed_posts.ppv_post_id
 *   post_type 'video'        'video_short' | 'video_long'
 *   video_status 'draft' |   'pending' | 'uploading' | 'processing' |
 *     'encoding'             'ready' | 'failed' | 'deleted'
 *   updated_at               — does not exist on feed_posts
 *
 * A draft is `publish_status = 'draft'`; the Bunny webhook flips it to
 * 'published' when encoding finishes.
 */

/** feed_posts.access_level CHECK. 'free_preview' is read-only for now. */
export type AccessLevel = 'public' | 'subscribers' | 'ppv' | 'free_preview';

/** The subset of access levels this UI can set. */
export type CreatorVisibility = Extract<AccessLevel, 'public' | 'subscribers' | 'ppv'>;

/** feed_posts.post_type CHECK. Only the two video types are written here. */
export type PostType =
  | 'text'
  | 'image'
  | 'video_short'
  | 'video_long'
  | 'live_scheduled'
  | 'live_active'
  | 'live_ended';

/** The two post types content-request-video-upload accepts. */
export type VideoPostType = Extract<PostType, 'video_short' | 'video_long'>;

/** feed_posts.video_status CHECK. Written only by the backend + Bunny webhook. */
export type VideoStatus =
  | 'pending'
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted';

/** feed_posts.publish_status CHECK. */
export type PublishStatus = 'draft' | 'scheduled' | 'published' | 'archived';

/** feed_posts.aspect_ratio — free text in the DB, these three in practice. */
export type AspectRatio = '16:9' | '9:16' | '1:1';

/**
 * One row of feed_posts, as the creator screens read it.
 *
 * `creator_id` is creators.id, NOT auth.users.id — every query has to resolve
 * the creator row first (see useCreatorProfile).
 */
export interface CreatorPost {
  id: string;
  creator_id: string;
  post_type: PostType;
  /** Nullable in the DB; every video post the upload flow creates has one. */
  title: string | null;
  /** The description field. Named `content` in the schema. */
  content: string | null;
  access_level: AccessLevel;
  /** FK to ppv_posts, where the star price actually lives. Null today. */
  ppv_post_id: string | null;
  video_provider: string | null;
  video_uid: string | null;
  video_status: VideoStatus | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  aspect_ratio: string | null;
  file_size_bytes: number | null;
  view_count: number;
  like_count: number;
  comment_count: number;
  tip_stars_received: number;
  publish_status: PublishStatus;
  scheduled_publish_at: string | null;
  published_at: string | null;
  created_at: string;
}

/**
 * The columns the creator screens select. Explicit rather than `*` so a new
 * backend column cannot silently change the shape this code type-asserts.
 */
export const POST_COLUMNS =
  'id, creator_id, post_type, title, content, access_level, ppv_post_id, ' +
  'video_provider, video_uid, video_status, duration_seconds, thumbnail_url, ' +
  'aspect_ratio, file_size_bytes, view_count, like_count, comment_count, ' +
  'tip_stars_received, publish_status, scheduled_publish_at, published_at, created_at';

/** Body of content-request-video-upload. */
export interface UploadRequestPayload {
  title: string;
  description?: string;
  post_type: VideoPostType;
  duration_seconds?: number;
  aspect_ratio?: AspectRatio;
  access_level?: CreatorVisibility;
  /**
   * Accepted by the function's signature but NOT persisted by the deployed
   * version — it creates no ppv_posts row. Sent anyway so the field is right
   * the day the backend starts storing it; the UI keeps PPV behind
   * CREATOR_PPV_ENABLED until then. See components/creator/VisibilityToggle.
   */
  ppv_price_stars?: number;
  scheduled_publish_at?: string;
}

/** 200 response from content-request-video-upload. */
export interface UploadRequestResponse {
  /** The draft feed_posts row. */
  post_id: string;
  /** Bunny Stream video GUID. The brief calls this `video_uid`. */
  video_guid: string;
  /** Bunny Stream video endpoint. PUT the raw file here. */
  upload_url: string;
  upload_method: 'PUT';
  /**
   * Send these verbatim and do not add to them.
   *
   * SECURITY: the deployed backend puts the Bunny Stream library API key in
   * here, so this object is a credential. Never log it, never persist it,
   * never put it in a URL. Flagged to the backend owner — the fix is a
   * per-video presigned TUS/PUT signature rather than the library key.
   */
  upload_headers: Record<string, string>;
  playback_hls_url: string;
  thumbnail_url: string;
  quota_details?: Record<string, unknown> | null;
}

/** 200 response from content-get-playback-url when the caller is entitled. */
export interface PlaybackUrlResponse {
  has_access: true;
  access_reason: string;
  post_id: string;
  title: string | null;
  /** HLS manifest. The brief calls this `hls_url`. */
  playback_url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
}
