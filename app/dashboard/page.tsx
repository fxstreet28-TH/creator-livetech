'use client';

/**
 * /dashboard — the signed-in homepage.
 *
 * Every section now reads the database. The four hardcoded creators
 * ("อ.ปอ AURUM", "CryptoKing TH", "แม่หมอส้ม", "โค้ชแอน"), the six invented
 * live sessions with their 3.2k / 5.8k viewer counts, and the five fake
 * activity rows are gone, along with lib/mockData.ts itself — the file, not
 * just its imports, so nothing can quietly grow a new usage.
 *
 * "กิจกรรมล่าสุด" is not replaced: there is no activity feed table to read it
 * from, and inventing one out of feed_posts would be the same mock data with
 * more steps. "หมวดหมู่ยอดนิยม" stays — it is a static taxonomy, not
 * fabricated data about creators who do not exist.
 */

import { useDashboardUser } from '@/lib/hooks/useDashboardUser';
import { useViewerCounts } from '@/lib/hooks/useViewerCounts';
import { HeroWelcome } from '@/components/dashboard/HeroWelcome';
import { LiveNowSection } from '@/components/dashboard/LiveNowSection';
import { RecommendedPosts } from '@/components/dashboard/RecommendedPosts';
import { PopularCategories } from '@/components/dashboard/PopularCategories';

export default function DashboardPage() {
  const { displayName, loading } = useDashboardUser();
  const { followingCount, subscriptionCount } = useViewerCounts();

  // The layout's DashboardChrome already proved a session exists before this
  // mounts, but this hook instance resolves its own first read. Returning null
  // for that tick avoids rendering "สวัสดี, " before the name arrives; the
  // layout's skeleton is what the user sees.
  if (loading) {
    return null;
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10">
      <HeroWelcome
        displayName={displayName}
        followingCount={followingCount}
        subscriptionCount={subscriptionCount}
      />
      {/* Renders nothing while live_sessions is empty — see LiveNowSection. */}
      <LiveNowSection />
      <RecommendedPosts />
      <PopularCategories />
    </div>
  );
}
