'use client';

/**
 * "แนะนำสำหรับคุณ" — the eight most-watched published videos, replacing the
 * four hardcoded creator cards that used to live here.
 *
 * Reuses the viewer feed's card so a post looks the same on the dashboard as
 * it does on /discover, and ranks by view_count rather than recency: with one
 * creator at launch, "newest" and "the whole feed" are the same list, and
 * "most watched" at least earns the heading.
 */

import Link from 'next/link';
import { usePublicFeed } from '@/lib/hooks/usePublicFeed';
import { PublicFeedGrid } from '@/components/viewer/PublicFeedGrid';

export function RecommendedPosts() {
  const { posts, loading, error } = usePublicFeed({ order: 'popular', pageSize: 8 });

  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">แนะนำสำหรับคุณ</h2>
        <Link href="/discover" className="text-sm text-purple-300 transition hover:text-purple-200">
          ดูทั้งหมด →
        </Link>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
        >
          {error}
        </p>
      )}

      <div className="mt-4">
        <PublicFeedGrid posts={posts} loading={loading} columns="dense" emptyReason="feed" />
      </div>
    </section>
  );
}
