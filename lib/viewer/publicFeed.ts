'use client';

/**
 * Typed reads for the viewer screens, straight from PostgREST with the browser
 * client. Same reasoning as useCreatorPosts: RLS is the boundary, so a
 * function in front of these would add a hop and a second place for the filter
 * to be wrong. The one exception is playback, which has to go through an Edge
 * Function because only the service role can mint a CDN URL.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE LIVE RLS ACTUALLY ALLOWS — read this before changing a query
 * ---------------------------------------------------------------------------
 * The sprint brief describes a feed that returns every published post and lets
 * the UI paint lock overlays on the ones the viewer cannot watch. The deployed
 * policies do not work that way, and the difference drives most of the design
 * below. Verified against project hknvooaqgpufrbdxtzxf:
 *
 *  1. `feed_posts_public_read` is
 *       publish_status = 'published' AND video_status <> 'deleted'
 *       AND access_level = 'public'
 *     — the access_level clause is the part the brief omits. A 'subscribers'
 *     or 'ppv' post is invisible to anyone without an entitlement, metadata
 *     included, so the feed cannot preview locked posts. `AccessLockCard` is
 *     still reachable, but only through a direct /posts/[id] URL, where the
 *     playback function (service role) answers 403 with enough metadata to
 *     render the preview. That is why fetchPlayback() below keeps the denied
 *     body instead of collapsing it into an error.
 *
 *  2. `creators` has NO public SELECT policy — only "own row" and CRM admin.
 *     An anonymous visitor reads ZERO creator rows, so the brief's
 *     `creators!inner (...)` embed would inner-join every post out of the feed
 *     and /discover would render empty in incognito. The embed here is
 *     deliberately NOT `!inner`, and creator identity is resolved separately
 *     from `creator_profiles`, which does have a public policy
 *     (`is_public = true`). See resolveCreatorSummary().
 *
 *  3. `creator_profiles` is empty and every `creators.handle` /
 *     `display_name` / `category` is NULL today. Every consumer therefore has
 *     to render a creator with no name, no handle and no avatar. That is the
 *     normal case at launch, not an error state.
 *
 * None of this is worked around here — it is read as the contract. The PR
 * notes the two policies Por may want to add.
 */

import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import type {
  CreatorSummary,
  LiveSessionSummary,
  PlaybackAllowed,
  PlaybackDenied,
  PlaybackFailure,
  PlaybackResult,
  PublicCreatorProfile,
  PublicPost,
  SubscriptionPlanSummary,
} from './types';

/** Page size for /discover and "โหลดเพิ่ม". */
export const FEED_PAGE_SIZE = 30;

/**
 * Bunny Stream CDN host, for the thumbnail fallback on posts whose
 * `thumbnail_url` the webhook has not filled in yet.
 *
 * The backend reads the same hostname from Vault, which the browser cannot do,
 * so it is duplicated here — same contract as lib/creator/constants.ts: the
 * backend stays the authority and drift costs a broken image, never a bad row.
 * Overridable so a library swap does not need a code change.
 */
const BUNNY_CDN_HOSTNAME =
  process.env.NEXT_PUBLIC_BUNNY_STREAM_CDN_HOSTNAME || 'vz-46d7a368-5c3.b-cdn.net';

/**
 * Explicit rather than `*`, for the same reason POST_COLUMNS is: a new backend
 * column must not silently change the shape this module type-asserts.
 *
 * `creators (...)` is a LEFT embed on purpose — see note 2 in the header.
 * `ppv_posts (price_stars)` resolves through feed_posts.ppv_post_id and is
 * gated by `ppv_posts_select_published`, so it is null until a creator
 * actually publishes a PPV price.
 */
const FEED_COLUMNS = `
  id, creator_id, title, content, post_type, access_level, ppv_post_id,
  video_uid, video_status, duration_seconds, thumbnail_url, aspect_ratio,
  view_count, like_count, tip_stars_received, published_at, created_at,
  creators ( id, handle, display_name, category ),
  ppv_posts ( price_stars )
`;

/** Only finished video posts appear in the viewer feed. */
const FEED_POST_TYPES = ['video_short', 'video_long'];

/** Thai, renderable. The screens show this verbatim. */
const READ_ERROR = 'โหลดเนื้อหาไม่สำเร็จ กรุณาลองใหม่';

export interface FeedResult {
  posts: PublicPost[];
  /** Thai, renderable. Null on success. */
  error: string | null;
}

export type FeedOrder = 'recent' | 'popular';

export interface FeedQuery {
  /** Rows to return. Defaults to FEED_PAGE_SIZE. */
  limit?: number;
  /** Rows to skip, for "โหลดเพิ่ม". Defaults to 0. */
  offset?: number;
  /** Restrict to one creator — /c/[handle]. */
  creatorId?: string;
  /**
   * Restrict to a set of creators — the "กำลังติดตาม" tab. An EMPTY array
   * means "follows nobody", which must return nothing rather than everything,
   * so it is passed through rather than treated as absent.
   */
  creatorIds?: string[];
  /** 'popular' is view_count DESC then recency — the dashboard's ordering. */
  order?: FeedOrder;
}

/**
 * PostgREST returns a to-one embed as an object, but a client that guesses
 * wrong about a constraint gets an array. Both shapes are accepted rather than
 * asserted, because the failure mode of guessing is a card that renders
 * "undefined" for every field.
 */
function firstOf(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? null;
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Merge what the two readable sources know about a creator.
 *
 * `creator_profiles` wins where it has a value: its `handle` and
 * `display_name` are NOT NULL and its `handle` is the unique one, whereas the
 * matching columns on `creators` are nullable and empty in production. It is
 * also the only one of the two an anonymous visitor can read at all.
 */
function resolveCreatorSummary(
  creatorId: string,
  creatorRow: Record<string, unknown> | null,
  profile: PublicCreatorProfile | undefined,
): CreatorSummary {
  return {
    id: creatorId,
    handle: profile?.handle ?? text(creatorRow?.handle),
    display_name: profile?.display_name ?? text(creatorRow?.display_name),
    category: profile?.category ?? text(creatorRow?.category),
    avatar_url: profile?.avatar_url ?? null,
  };
}

function toPublicPost(
  row: Record<string, unknown>,
  profiles: Map<string, PublicCreatorProfile>,
): PublicPost {
  const creatorId = String(row.creator_id);
  const creatorRow = firstOf(row.creators);
  const ppv = firstOf(row.ppv_posts);
  const price = ppv?.price_stars;

  return {
    id: String(row.id),
    creator_id: creatorId,
    creator: resolveCreatorSummary(creatorId, creatorRow, profiles.get(creatorId)),
    title: text(row.title),
    content: text(row.content),
    post_type: row.post_type as PublicPost['post_type'],
    access_level: row.access_level as PublicPost['access_level'],
    ppv_post_id: text(row.ppv_post_id),
    ppv_price_stars: typeof price === 'number' ? price : null,
    video_uid: text(row.video_uid),
    video_status: (row.video_status as PublicPost['video_status']) ?? null,
    duration_seconds: typeof row.duration_seconds === 'number' ? row.duration_seconds : null,
    thumbnail_url: text(row.thumbnail_url),
    aspect_ratio: text(row.aspect_ratio),
    view_count: count(row.view_count),
    like_count: count(row.like_count),
    tip_stars_received: count(row.tip_stars_received),
    published_at: text(row.published_at),
    created_at: String(row.created_at),
  };
}

function toProfile(row: Record<string, unknown>): PublicCreatorProfile {
  return {
    creator_id: String(row.creator_id),
    handle: text(row.handle),
    display_name: text(row.display_name),
    category: text(row.category),
    bio: text(row.bio),
    avatar_url: text(row.avatar_url),
    cover_url: text(row.cover_url),
    total_subscribers: count(row.total_subscribers),
    total_followers: count(row.total_followers),
  };
}

const PROFILE_COLUMNS =
  'creator_id, handle, display_name, category, bio, avatar_url, cover_url, ' +
  'total_subscribers, total_followers';

/**
 * Public profiles for a set of creator ids.
 *
 * A failure here is deliberately swallowed to an empty map rather than
 * propagated: a feed of unnamed cards is worth showing, a feed of nothing
 * because the avatar lookup 500'd is not.
 */
async function fetchProfiles(
  supabase: SupabaseClient,
  creatorIds: string[],
): Promise<Map<string, PublicCreatorProfile>> {
  const map = new Map<string, PublicCreatorProfile>();
  if (creatorIds.length === 0) return map;

  const { data, error } = await supabase
    .from('creator_profiles')
    .select(PROFILE_COLUMNS)
    .in('creator_id', creatorIds);

  if (error) {
    console.error('[publicFeed] creator_profiles read failed', error);
    return map;
  }

  for (const row of data ?? []) {
    const profile = toProfile(row as unknown as Record<string, unknown>);
    map.set(profile.creator_id, profile);
  }
  return map;
}

/**
 * Published video posts the caller is allowed to see, newest (or most-viewed)
 * first.
 *
 * `video_status = 'ready'` excludes anything Bunny has not finished with:
 * a post whose encode is still running has no playable manifest, and a card
 * that leads to "ยังไม่พร้อมรับชม" is worse than no card.
 */
export async function fetchPublicFeed(
  supabase: SupabaseClient,
  query: FeedQuery = {},
): Promise<FeedResult> {
  const limit = query.limit ?? FEED_PAGE_SIZE;
  const offset = query.offset ?? 0;

  if (query.creatorIds && query.creatorIds.length === 0) {
    return { posts: [], error: null };
  }

  let request = supabase
    .from('feed_posts')
    .select(FEED_COLUMNS)
    .eq('publish_status', 'published')
    .eq('video_status', 'ready')
    .in('post_type', FEED_POST_TYPES);

  if (query.creatorId) request = request.eq('creator_id', query.creatorId);
  if (query.creatorIds) request = request.in('creator_id', query.creatorIds);

  if (query.order === 'popular') {
    request = request.order('view_count', { ascending: false });
  }
  // Recency is the tiebreaker under 'popular' and the sole key otherwise.
  // nullsFirst: false keeps a row whose published_at never got written (the
  // column is nullable) at the bottom instead of at the top of the feed.
  request = request
    .order('published_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);

  const { data, error } = await request;

  if (error) {
    console.error('[publicFeed] feed_posts read failed', error);
    return { posts: [], error: READ_ERROR };
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const creatorIds = [...new Set(rows.map((row) => String(row.creator_id)))];
  const profiles = await fetchProfiles(supabase, creatorIds);

  return { posts: rows.map((row) => toPublicPost(row, profiles)), error: null };
}

export interface PublicPostResult {
  post: PublicPost | null;
  /** No readable row — either no such post, or RLS hides it from this viewer. */
  notFound: boolean;
  error: string | null;
}

/**
 * One post's metadata.
 *
 * `notFound` and "locked" are indistinguishable here by design: RLS filters a
 * post the viewer cannot watch out of the result entirely (header note 1), so
 * a null row is not yet an answer. /posts/[id] resolves the ambiguity by
 * asking the playback function, which sees every row.
 */
export async function fetchPublicPost(
  supabase: SupabaseClient,
  postId: string,
): Promise<PublicPostResult> {
  // maybeSingle, not single: a row filtered out by RLS is the expected
  // outcome for a locked post, and single() turns that into a thrown error.
  const { data, error } = await supabase
    .from('feed_posts')
    .select(FEED_COLUMNS)
    .eq('id', postId)
    .maybeSingle();

  if (error) {
    console.error('[publicFeed] post read failed', error);
    return { post: null, notFound: false, error: READ_ERROR };
  }
  if (!data) return { post: null, notFound: true, error: null };

  const row = data as unknown as Record<string, unknown>;
  const profiles = await fetchProfiles(supabase, [String(row.creator_id)]);
  return { post: toPublicPost(row, profiles), notFound: false, error: null };
}

/**
 * The creator ids the signed-in user follows, for the "กำลังติดตาม" tab.
 *
 * `follows.follower_id` is auth.users.id (the RLS policy is
 * `auth.uid() = follower_id`), not creators.id — so this takes the user id,
 * not the viewer's own creator id.
 */
export async function fetchFollowedCreatorIds(supabase: SupabaseClient): Promise<{
  creatorIds: string[];
  error: string | null;
}> {
  const { data, error } = await supabase.from('follows').select('creator_id');

  if (error) {
    console.error('[publicFeed] follows read failed', error);
    return { creatorIds: [], error: READ_ERROR };
  }
  return {
    creatorIds: (data ?? []).map((row) => String((row as { creator_id: unknown }).creator_id)),
    error: null,
  };
}

/**
 * Sessions that are on air right now, most-watched first.
 *
 * `live_sessions_public_active_read` covers 'waiting' and 'live' for public
 * sessions, so this needs no new policy — but it also means a gated live never
 * appears here, exactly as a gated post never appears in the video feed.
 *
 * Callers hide their section rather than render an empty one.
 *
 * TODO(post-launch): a session whose broadcaster closed the tab without
 * pressing "จบไลฟ์" stays 'waiting'/'live' forever and keeps showing here.
 * Only live-end-session closes a row today; a reaper needs to exist.
 */
export async function fetchLiveSessions(
  supabase: SupabaseClient,
  limit = 8,
): Promise<{ sessions: LiveSessionSummary[]; error: string | null }> {
  const { data, error } = await supabase
    .from('live_sessions')
    .select(
      `id, creator_id, room_name, title, current_viewer_count, cover_image_url,
       access_level, creators ( id, handle, display_name, category )`,
    )
    // 'waiting' as well as 'live': live-create-session inserts the row as
    // 'waiting' and the backend never promotes it — only the broadcaster does
    // (markSessionLive in lib/live/api.ts), and that write is best-effort. A
    // feed filtered on 'live' alone would hide a session that is genuinely on
    // air whenever that one UPDATE is refused or has not landed yet.
    .in('status', ['live', 'waiting'])
    .order('current_viewer_count', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[publicFeed] live_sessions read failed', error);
    return { sessions: [], error: READ_ERROR };
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const profiles = await fetchProfiles(
    supabase,
    [...new Set(rows.map((row) => String(row.creator_id)))],
  );

  return {
    sessions: rows.map((row) => {
      const creatorId = String(row.creator_id);
      return {
        id: String(row.id),
        creator_id: creatorId,
        creator: resolveCreatorSummary(
          creatorId,
          firstOf(row.creators),
          profiles.get(creatorId),
        ),
        room_name: String(row.room_name),
        title: String(row.title),
        current_viewer_count: count(row.current_viewer_count),
        cover_image_url: text(row.cover_image_url),
        access_level: row.access_level as LiveSessionSummary['access_level'],
      };
    }),
    error: null,
  };
}

/**
 * One creator's identity, for a screen that has a creator_id and nothing else
 * — the live watch page, which reads `live_sessions` and gets no embed.
 *
 * Same two-source merge as the feed cards (resolveCreatorSummary): the
 * `creators` row for what it has, `creator_profiles` on top for what it
 * actually fills in. Both reads are allowed to fail to null — a live with an
 * unnamed creator still plays, and the display helpers already render that
 * case (see components/viewer/creatorDisplay).
 */
export async function fetchCreatorSummary(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<CreatorSummary> {
  const [creator, profiles] = await Promise.all([
    supabase.from('creators').select('id, handle, display_name, category').eq('id', creatorId).maybeSingle(),
    fetchProfiles(supabase, [creatorId]),
  ]);

  if (creator.error) console.error('[publicFeed] creators read failed', creator.error);

  return resolveCreatorSummary(
    creatorId,
    (creator.data as Record<string, unknown> | null) ?? null,
    profiles.get(creatorId),
  );
}

/**
 * A creator's public profile by handle, for /c/[handle].
 *
 * `creator_profiles.handle` is the canonical one — UNIQUE, NOT NULL, and
 * publicly readable when `is_public` — whereas `creators.handle` is nullable
 * and NULL on every row in production. `creators` is tried second anyway, so
 * the page starts working the moment either table gets a handle.
 */
export async function fetchCreatorByHandle(
  supabase: SupabaseClient,
  handle: string,
): Promise<{ profile: PublicCreatorProfile | null; notFound: boolean; error: string | null }> {
  const { data, error } = await supabase
    .from('creator_profiles')
    .select(PROFILE_COLUMNS)
    .eq('handle', handle)
    .maybeSingle();

  if (error) {
    console.error('[publicFeed] creator_profiles by handle failed', error);
    return { profile: null, notFound: false, error: READ_ERROR };
  }
  if (data) {
    return { profile: toProfile(data as unknown as Record<string, unknown>), notFound: false, error: null };
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('id, handle, display_name, category, bio')
    .eq('handle', handle)
    .maybeSingle();

  if (creatorError) {
    console.error('[publicFeed] creators by handle failed', creatorError);
    return { profile: null, notFound: false, error: READ_ERROR };
  }
  if (!creator) return { profile: null, notFound: true, error: null };

  const row = creator as unknown as Record<string, unknown>;
  return {
    profile: {
      creator_id: String(row.id),
      handle: text(row.handle),
      display_name: text(row.display_name),
      category: text(row.category),
      bio: text(row.bio),
      avatar_url: null,
      cover_url: null,
      total_subscribers: 0,
      total_followers: 0,
    },
    notFound: false,
    error: null,
  };
}

/**
 * A creator's active subscription plans, for the subscribers lock card.
 *
 * `plans_select_active` makes these publicly readable, so this works for an
 * anonymous viewer. The table is empty until the plan-creation UI ships on
 * Day 8, so an empty list is the normal answer and the lock card simply omits
 * the section. A failure is swallowed for the same reason as fetchProfiles:
 * missing plans must not take down the paywall that explains the lock.
 */
export async function fetchSubscriptionPlans(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<SubscriptionPlanSummary[]> {
  const { data, error } = await supabase
    .from('subscription_plans')
    .select('id, name, description, price_stars, price_thb, benefits')
    .eq('creator_id', creatorId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true, nullsFirst: false });

  if (error) {
    console.error('[publicFeed] subscription_plans read failed', error);
    return [];
  }

  return (data ?? []).map((entry) => {
    const row = entry as unknown as Record<string, unknown>;
    return {
      id: String(row.id),
      name: String(row.name),
      description: text(row.description),
      price_stars: typeof row.price_stars === 'number' ? row.price_stars : null,
      // numeric comes back as a string over PostgREST; Number() covers both.
      price_thb: Number(row.price_thb ?? 0),
      benefits: Array.isArray(row.benefits) ? row.benefits.map(String) : [],
    };
  });
}

const NETWORK_FAILURE: PlaybackFailure = {
  code: 'network_error',
  message: 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
};

/** Thai for the failures this call can end in. Denial is not one of them. */
function thaiForPlaybackError(code: string, status: number): PlaybackFailure {
  if (status === 401) {
    return { code: 'unauthenticated', message: 'กรุณาเข้าสู่ระบบเพื่อรับชม', status };
  }
  if (code === 'video_not_ready' || status === 409) {
    return { code: 'video_not_ready', message: 'วิดีโอนี้ยังไม่พร้อมรับชม', status };
  }
  if (code === 'not_published') {
    return { code, message: 'โพสต์นี้ยังไม่ถูกเผยแพร่', status };
  }
  if (status === 404) {
    return { code: 'not_found', message: 'ไม่พบโพสต์นี้', status };
  }
  return { code: code || 'internal_error', message: 'เปิดวิดีโอไม่สำเร็จ กรุณาลองใหม่', status };
}

/**
 * Ask content-get-playback-url for an HLS manifest.
 *
 * Not lib/creator/api.ts's getPlaybackUrl: that wrapper folds the 403
 * `has_access: false` body into a generic ContentError, which is right for the
 * creator screens (a creator is always entitled to their own post, so a denial
 * there means something is wrong) and wrong here, where a denial is the normal
 * path for every locked post and carries the title and thumbnail the lock card
 * renders.
 *
 * The function is deployed with verify_jwt, so an anonymous viewer is rejected
 * by the gateway at 401 before any of its code runs. That is reported as
 * 'unauthenticated' and the page offers a login link rather than a paywall.
 */
export async function fetchPlayback(
  supabase: SupabaseClient,
  postId: string,
): Promise<PlaybackResult> {
  try {
    const { data, error } = await supabase.functions.invoke<PlaybackAllowed>(
      'content-get-playback-url',
      { method: 'POST', body: { post_id: postId } },
    );

    if (error) {
      if (error instanceof FunctionsHttpError && error.context instanceof Response) {
        const response = error.context;
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          // An HTML error page from the platform rather than a function body.
        }

        const parsed = body as { has_access?: boolean; error?: { code?: string } } | null;
        if (parsed?.has_access === false) {
          return { kind: 'denied', playback: parsed as unknown as PlaybackDenied };
        }
        return {
          kind: 'error',
          error: thaiForPlaybackError(parsed?.error?.code ?? '', response.status),
        };
      }
      return { kind: 'error', error: NETWORK_FAILURE };
    }

    if (!data) return { kind: 'error', error: NETWORK_FAILURE };
    return { kind: 'allowed', playback: data };
  } catch (err) {
    console.error('[publicFeed] content-get-playback-url failed', err);
    return { kind: 'error', error: NETWORK_FAILURE };
  }
}

/**
 * Optimistic like. Returns the stored count, or null if the write failed.
 *
 * TODO(day-9): add per-user like tracking. `increment_like_count` is a bare
 * SECURITY DEFINER counter with no dedup and no per-user row, so the same
 * viewer can like a post repeatedly and nothing can ever un-like it. The
 * button reflects that honestly: it fires once per page load and does not
 * offer an undo.
 */
export async function likePost(
  supabase: SupabaseClient,
  postId: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc('increment_like_count', {
    p_post_id: postId,
    p_delta: 1,
  });

  if (error) {
    console.error('[publicFeed] increment_like_count failed', error);
    return null;
  }
  return typeof data === 'number' ? data : null;
}

/**
 * Poster for a card or player.
 *
 * `thumbnail_url` is filled in by the Bunny webhook and is null on posts whose
 * encode finished before that column existed — the CDN serves a thumbnail at a
 * predictable path either way, so the fallback is a real image rather than a
 * placeholder.
 */
export function thumbnailFor(
  post: Pick<PublicPost, 'thumbnail_url' | 'video_uid'>,
): string | null {
  if (post.thumbnail_url) return post.thumbnail_url;
  if (post.video_uid) return `https://${BUNNY_CDN_HOSTNAME}/${post.video_uid}/thumbnail.jpg`;
  return null;
}

/** Tailwind aspect class for a post's `aspect_ratio`. 16:9 when unset. */
export function aspectClassFor(aspectRatio: string | null | undefined): string {
  if (aspectRatio === '9:16') return 'aspect-[9/16]';
  if (aspectRatio === '1:1') return 'aspect-square';
  return 'aspect-video';
}
