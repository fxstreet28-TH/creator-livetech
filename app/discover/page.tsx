'use client';

/**
 * /discover — the feed.
 *
 * Login required. The product decision is that every viewer flow is
 * authenticated, and the backend now enforces it: the feed_posts_preview_read
 * and creators_public_read policies are scoped to `authenticated`, so an
 * anonymous visitor would only ever see an empty page. The gate turns that
 * into a redirect to /login?redirect=/discover instead.
 *
 * The page still sits outside app/dashboard: DashboardChrome carries the
 * sidebar and a different frame, and these pages paint their own via
 * ViewerPageShell. The shell renders a "กลับแดชบอร์ด" link to get back.
 */

import { Suspense, useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useLiveSessions } from '@/lib/hooks/useLiveSessions';
import { usePublicFeed } from '@/lib/hooks/usePublicFeed';
import { FeedEmptyState } from '@/components/viewer/FeedEmptyState';
import { FeedFilterTabs, parseFeedTab, type FeedTab } from '@/components/viewer/FeedFilterTabs';
import { LiveSessionGrid } from '@/components/viewer/LiveSessionGrid';
import { PublicFeedGrid } from '@/components/viewer/PublicFeedGrid';
import { ViewerPageShell } from '@/components/viewer/ViewerPageShell';

export default function DiscoverPage() {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return (
    <ViewerPageShell
      title="ค้นพบเนื้อหา"
      subtitle="เนื้อหาล่าสุดจาก Creators"
      backHref="/dashboard"
      backLabel="กลับแดชบอร์ด"
    >
      {/* useSearchParams suspends during prerender. Without this boundary the
          whole page would have to opt out of static generation, which the
          Capacitor export cannot do. Same pattern as /wallet. */}
      <Suspense fallback={<FeedSkeleton />}>
        <DiscoverContent />
      </Suspense>
    </ViewerPageShell>
  );
}

function FeedSkeleton() {
  return (
    <div aria-hidden className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-72 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      ))}
    </div>
  );
}

function DiscoverContent() {
  const params = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<FeedTab>(() => parseFeedTab(params.get('tab')));

  const { user, loading: userLoading } = useDashboardUser();

  const feed = usePublicFeed({
    followingOnly: tab === 'following',
    enabled: tab !== 'live',
  });
  const live = useLiveSessions(24);

  // Keep ?tab= in the URL so the sidebar's "ดูทั้งหมด →" deep links land on
  // the right tab and a reload keeps it. replace, not push: three tabs of one
  // page should not be three Back presses.
  const selectTab = useCallback(
    (next: FeedTab) => {
      setTab(next);
      router.replace(next === 'all' ? '/discover' : `/discover?tab=${next}`, { scroll: false });
    },
    [router],
  );

  return (
    <>
      <FeedFilterTabs value={tab} onChange={selectTab} />

      <div className="mt-6">
        {tab === 'live' ? (
          <LiveTab loading={live.loading} sessions={live.sessions} error={live.error} />
        ) : (
          <>
            {feed.error && (
              <p
                role="alert"
                className="mb-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
              >
                {feed.error}
              </p>
            )}

            {feed.requiresAuth ? (
              <FeedEmptyState reason="following_anonymous" />
            ) : (
              <PublicFeedGrid
                posts={feed.posts}
                loading={feed.loading || (tab === 'following' && userLoading && !user)}
                emptyReason={tab === 'following' ? 'following' : 'feed'}
              />
            )}

            {feed.hasMore && (
              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  onClick={feed.loadMore}
                  disabled={feed.loadingMore}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-white/85 transition hover:bg-white/[0.08] disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                >
                  {feed.loadingMore && <Loader2 size={16} className="animate-spin" aria-hidden />}
                  โหลดเพิ่ม
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function LiveTab({
  loading,
  sessions,
  error,
}: {
  loading: boolean;
  sessions: ReturnType<typeof useLiveSessions>['sessions'];
  error: string | null;
}) {
  if (loading) return <FeedSkeleton />;
  if (error) {
    return (
      <p
        role="alert"
        className="rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
      >
        {error}
      </p>
    );
  }
  if (sessions.length === 0) return <FeedEmptyState reason="live" />;
  return <LiveSessionGrid sessions={sessions} />;
}
