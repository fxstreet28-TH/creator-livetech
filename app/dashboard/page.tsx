import { getDashboardUser } from '@/lib/session';
import { HeroWelcome } from '@/components/dashboard/HeroWelcome';
import { LiveNowCarousel } from '@/components/dashboard/LiveNowCarousel';
import { RecommendedCreators } from '@/components/dashboard/RecommendedCreators';
import { PopularCategories } from '@/components/dashboard/PopularCategories';
import { RecentActivity } from '@/components/dashboard/RecentActivity';

export default async function DashboardPage() {
  const user = await getDashboardUser();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10">
      <HeroWelcome displayName={user.displayName} followingCount={0} subscriptionCount={0} />
      <LiveNowCarousel />
      <RecommendedCreators />
      <PopularCategories />
      <RecentActivity />
    </div>
  );
}
