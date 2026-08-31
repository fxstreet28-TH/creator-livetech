/**
 * User-facing feature flags read from public env vars.
 *
 * Keep this file small — one exported const per flag, no logic. The point is
 * that flipping a boolean in Vercel env should be enough to change UI, without
 * any code path branching in a way that hides bugs from tests.
 *
 * Every flag defaults to false: an unset env var reads as `undefined`, which
 * is not the string 'true'. A feature that has to be switched on deliberately
 * cannot leak out of a preview build that forgot to set it.
 */

/**
 * Self-service buyback for users — the /wallet/buyback form, its entry point
 * on /wallet, and the Buyback history tab.
 *
 * Off since Aug 2026: buyback requests are taken through support (LINE/email)
 * and created by an admin in the CRM, because a user-created request is paid
 * out by hand and needs identity and bank-account verification first. The
 * backend (the buyback-request Edge Function, request_buyback, and
 * buyback_requests) stays live for the CRM to call, and buyback rows still
 * render in the user's full history — this flag hides the UI, nothing else.
 */
export const BUYBACK_USER_ENABLED =
  process.env.NEXT_PUBLIC_BUYBACK_USER_ENABLED === 'true';

/**
 * Pay-per-view as an option on the creator upload form.
 *
 * Off until the backend can store a PPV price. `content-request-video-upload`
 * accepts `ppv_price_stars` in its request type but never writes it: it
 * creates no `ppv_posts` row, so `feed_posts.ppv_post_id` stays NULL — and the
 * `feed_posts_ppv_unlocked_read` policy requires a non-null `ppv_post_id`,
 * while `content-get-playback-url` refuses any 'ppv' post without one. A
 * creator who chose PPV today would spend a video from their monthly quota on
 * a post that no viewer can watch, unlock, or pay for, with the price they
 * typed silently dropped.
 *
 * The UI is built and behind this flag rather than absent, so enabling PPV is
 * an env change once the backend writes the ppv_posts row.
 */
export const CREATOR_PPV_ENABLED = process.env.NEXT_PUBLIC_CREATOR_PPV_ENABLED === 'true';
