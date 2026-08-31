'use client';

/**
 * How a creator is named and pictured across the viewer screens.
 *
 * This exists because every field of CreatorSummary is nullable and, right
 * now, usually null: `creators.handle` / `display_name` / `category` are NULL
 * on every row in production, `creator_profiles` is empty, and an anonymous
 * visitor cannot read `creators` at all (no public SELECT policy). So "the
 * creator has no name" is the common case at launch, not an edge case, and
 * every card would otherwise grow its own `?? 'Creator'` chain that drifts.
 *
 * The fallbacks degrade in one direction: a display name, then the handle,
 * then a neutral Thai label. Never the raw uuid — an id is not a name, and
 * showing one leaks a database key into the UI for no benefit.
 */

import { Avatar } from '@/components/dashboard/Avatar';
import type { CreatorSummary } from '@/lib/viewer/types';

/** Shown when neither a display name nor a handle is known. */
const UNNAMED_CREATOR = 'Creator';

export function creatorDisplayName(creator: CreatorSummary | null | undefined): string {
  if (!creator) return UNNAMED_CREATOR;
  return creator.display_name?.trim() || creator.handle?.trim() || UNNAMED_CREATOR;
}

/** '@handle', or null when there is no handle to show. */
export function creatorHandleLabel(creator: CreatorSummary | null | undefined): string | null {
  const handle = creator?.handle?.trim();
  return handle ? `@${handle}` : null;
}

/**
 * The profile URL, or null when the creator has no handle.
 *
 * /c/[handle] resolves a creator BY handle, so a link built from a missing one
 * can only 404. Callers render plain text instead of a dead link.
 */
export function creatorProfileHref(creator: CreatorSummary | null | undefined): string | null {
  const handle = creator?.handle?.trim();
  return handle ? `/c/${encodeURIComponent(handle)}` : null;
}

/** Avatar with the shared name fallback, so the initial is never '?' by surprise. */
export function CreatorAvatar({
  creator,
  size = 32,
  ring = false,
}: {
  creator: CreatorSummary | null | undefined;
  size?: number;
  ring?: boolean;
}) {
  return (
    <Avatar
      name={creatorDisplayName(creator)}
      src={creator?.avatar_url ?? null}
      size={size}
      ring={ring}
    />
  );
}
