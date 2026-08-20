'use client';

import { useDashboardUser } from '@/lib/hooks/useDashboardUser';
import { HeroWelcome } from '@/components/dashboard/HeroWelcome';
import { LiveNowCarousel } from '@/components/dashboard/LiveNowCarousel';
import { RecommendedCreators } from '@/components/dashboard/RecommendedCreators';
import { PopularCategories } from '@/components/dashboard/PopularCategories';
import { RecentActivity } from '@/components/dashboard/RecentActivity';

export default function DashboardPage() {
  const { displayName, loading } = useDashboardUser();

  // RouteGuard in the layout already proved a session exists before this
  // mounts, but this hook instance resolves its own first read. Returning null
  // for that tick avoids rendering "สวัสดี, " before the name arrives; the
  // layout's skeleton is what the user sees.
  if (loading) {
    return null;
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10">
      <HeroWelcome displayName={displayName} followingCount={0} subscriptionCount={0} />
      <LiveNowCarousel />
      <RecommendedCreators />
      <PopularCategories />
      <RecentActivity />
    </div>
  );
}
