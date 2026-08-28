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
