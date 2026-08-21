'use client';

/**
 * Client-side entitlement check. Reads a per-user cache — the source of
 * truth is server-side via RLS.
 *
 * NEVER use this alone to gate premium content. Content pages must:
 * 1. Check hasEntitlement() client-side for a fast optimistic render.
 * 2. Fetch the actual content via Supabase — RLS returns nothing if the
 *    user isn't entitled. The client cache being wrong just means a flash
 *    of "locked" state before the real check.
 *
 * The cache refreshes on:
 * - App foreground (via visibilitychange listener the caller must wire up)
 * - Explicit refetch + setEntitlements() after a purchase completes
 * - Every 5 minutes in the background (implementation deferred)
 */

import type { Entitlement } from './types';

// In-memory cache. Persisted across HMR reloads via module-level variable.
// Cleared on hard refresh — fine, we refetch immediately on mount.
const cache = new Map<string, Entitlement[]>();

export function hasEntitlement(
  userId: string,
  kind: Entitlement['kind'],
  refId: string,
): boolean {
  const items = cache.get(userId) ?? [];
  return items.some(
    (e) => e.kind === kind && e.refId === refId && e.status === 'active',
  );
}

export function getCachedEntitlements(userId: string): Entitlement[] {
  return cache.get(userId) ?? [];
}

/**
 * Populate the cache. The caller is responsible for actually fetching from
 * Supabase (this file doesn't own that query — it lives with whichever
 * component mounts first, usually the dashboard shell).
 */
export function setEntitlements(userId: string, items: Entitlement[]): void {
  cache.set(userId, items);
}

export function clearEntitlements(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
