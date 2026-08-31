'use client';

/**
 * The card grid shared by /discover, /c/[handle] and the dashboard's
 * "แนะนำสำหรับคุณ" section.
 *
 * One column on a phone, two on a tablet, three on a desktop. The dashboard
 * passes `columns="dense"` for its 8-up strip, which has a sidebar eating
 * ~240px and so fits four narrower cards at the same breakpoints.
 */

import { PublicPostCard } from './PublicPostCard';
import { FeedEmptyState, type EmptyReason } from './FeedEmptyState';
import type { PublicPost } from '@/lib/viewer/types';

interface PublicFeedGridProps {
  posts: PublicPost[];
  /** First load — renders skeletons instead of an empty state. */
  loading?: boolean;
  columns?: 'default' | 'dense';
  /** Which empty copy to show when there is nothing and nothing is loading. */
  emptyReason?: EmptyReason;
  /** Suppress the empty state entirely (the caller renders its own). */
  hideEmpty?: boolean;
}

const COLUMN_CLASS = {
  default: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  dense: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
} as const;

export function PublicFeedGrid({
  posts,
  loading = false,
  columns = 'default',
  emptyReason = 'feed',
  hideEmpty = false,
}: PublicFeedGridProps) {
  if (loading && posts.length === 0) {
    return (
      <div className={`grid gap-4 ${COLUMN_CLASS[columns]}`}>
        {Array.from({ length: columns === 'dense' ? 4 : 6 }, (_, i) => (
          <div
            key={i}
            aria-hidden
            className="h-72 animate-pulse rounded-2xl border border-white/10 bg-white/5"
          />
        ))}
      </div>
    );
  }

  if (posts.length === 0) {
    return hideEmpty ? null : <FeedEmptyState reason={emptyReason} />;
  }

  return (
    <div className={`grid gap-4 ${COLUMN_CLASS[columns]}`}>
      {posts.map((post) => (
        <PublicPostCard key={post.id} post={post} />
      ))}
    </div>
  );
}
