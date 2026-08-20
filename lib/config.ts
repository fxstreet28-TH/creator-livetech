/**
 * Runtime configuration.
 *
 * Single source of truth for:
 * - APP_WEB_URL: production web origin (used by native shell for checkout redirects
 *   and API calls until PR 5 moves routes to Supabase Edge Functions).
 * - API_BASE_URL: prefix for backend calls. Empty string on web (relative,
 *   same-origin fetches). On native, defaults to APP_WEB_URL so /api/auth/*
 *   routes on Vercel still work; after PR 5 this becomes the Edge Functions
 *   host.
 * - isNative(): true only when running inside a Capacitor shell.
 * - apiUrl(path): call this instead of hardcoding fetch('/api/...').
 *
 * NEXT_PUBLIC_* values are baked into the app bundle at build time.
 * A wrong value in the mobile build cannot be changed without a store re-release.
 */

import { Capacitor } from '@capacitor/core';

const isBrowser = typeof window !== 'undefined';

/**
 * Production web origin. Used by the native shell to open the checkout page
 * in an in-app browser (audit § P1 #9). Defaults to the current origin on the
 * web (so previews and dev work), or to the production URL if window is not
 * available (SSR / build).
 */
export const APP_WEB_URL: string =
  process.env.NEXT_PUBLIC_APP_WEB_URL ||
  (isBrowser ? window.location.origin : 'https://creatorlivetech.com');

/**
 * True only inside a Capacitor native shell. Safe to call during SSR (returns
 * false because Capacitor.isNativePlatform() returns false when window is
 * undefined).
 */
export function isNative(): boolean {
  return isBrowser && Capacitor.isNativePlatform();
}

/**
 * Base URL for backend API calls.
 *
 * - Web (Vercel): empty string — fetches stay relative, same-origin.
 * - Native: production web origin, so /api/auth/* on Vercel still resolves.
 *   Once PR 5 lands Edge Functions, override via NEXT_PUBLIC_API_BASE_URL
 *   in the mobile build.
 *
 * An explicit NEXT_PUBLIC_API_BASE_URL always wins if set.
 */
export const API_BASE_URL: string =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? (isNative() ? APP_WEB_URL : '');

/**
 * Build an API URL. Always call this instead of hardcoding fetch('/api/...').
 *
 *   apiUrl('/api/auth/login')
 *     → '/api/auth/login'                              (web)
 *     → 'https://creatorlivetech.com/api/auth/login'   (native, pre-PR-5)
 *
 * Accepts paths with or without a leading slash; always emits exactly one.
 */
export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalized}`;
}
