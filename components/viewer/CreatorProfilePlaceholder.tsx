'use client';

/**
 * The body of /c/[handle] — a PLACEHOLDER, deliberately.
 *
 * It exists so the "ดูโปรไฟล์" links from post detail do not 404, and it does
 * the one thing a visitor who followed such a link actually came for: it shows
 * who the creator is and what they have published. Subscribe plans, follow,
 * stats and DMs are the real profile page, which is a separate task.
 *
 * Split from the route file for the same reason as PublicPostView: the route
 * has to stay a Server Component so `generateStaticParams` can be exported.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { formatCount } from '@/lib/creator/format';
import { usePublicFeed } from '@/lib/hooks/usePublicFeed';
import { fetchCreatorByHandle } from '@/lib/viewer/publicFeed';
import type { PublicCreatorProfile } from '@/lib/viewer/types';
import { Avatar } from '@/components/dashboard/Avatar';
import { PublicFeedGrid } from './PublicFeedGrid';
import { ViewerPageShell } from './ViewerPageShell';

export function CreatorProfilePlaceholder({ handle }: { handle: string }) {
  const [profile, setProfile] = useState<PublicCreatorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        if (!cancelled) {
          setError('ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง');
          setLoading(false);
        }
        return;
      }

      const result = await fetchCreatorByHandle(supabase, handle);
      if (cancelled) return;

      setProfile(result.profile);
      setNotFound(result.notFound);
      setError(result.error);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [handle]);

  // The feed waits for the profile: creator_id is what filters it, and asking
  // for an unfiltered feed first would flash every creator's posts on the page.
  const feed = usePublicFeed({
    creatorId: profile?.creator_id,
    enabled: profile !== null,
  });

  if (loading) {
    return (
      <ViewerPageShell title="โปรไฟล์" backHref="/discover" backLabel="กลับไปที่ค้นพบ" bare>
        <div className="h-56 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      </ViewerPageShell>
    );
  }

  if (notFound || !profile) {
    return (
      <ViewerPageShell title="ไม่พบ Creator" backHref="/discover" backLabel="กลับไปที่ค้นพบ">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
          <p className="text-base font-semibold text-white">ไม่พบ Creator นี้</p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">
            {error ?? `ไม่พบผู้ใช้ @${handle} ในระบบ`}
          </p>
          <Link
            href="/discover"
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            ดูเนื้อหาทั้งหมด
          </Link>
        </div>
      </ViewerPageShell>
    );
  }

  const displayName = profile.display_name?.trim() || profile.handle?.trim() || 'Creator';

  return (
    <ViewerPageShell title={displayName} backHref="/discover" backLabel="กลับไปที่ค้นพบ" bare>
      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl">
        <div className="relative h-32 w-full sm:h-44">
          {profile.cover_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.cover_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-purple-600/45 via-[#1a1230] to-cyan-600/25" />
          )}
        </div>

        <div className="px-5 pb-5">
          <div className="-mt-10 flex items-end gap-3">
            <Avatar name={displayName} src={profile.avatar_url} size={80} ring />
            <div className="min-w-0 pb-1">
              <h1 className="truncate bg-gradient-to-r from-purple-300 to-cyan-300 bg-clip-text text-xl font-bold text-transparent">
                {displayName}
              </h1>
              {profile.handle && (
                <p className="truncate text-sm text-white/45">@{profile.handle}</p>
              )}
            </div>
          </div>

          {profile.category && (
            <span className="mt-3 inline-block rounded-full bg-purple-500/20 px-2.5 py-1 text-[11px] text-purple-200">
              {profile.category}
            </span>
          )}

          {profile.bio?.trim() && (
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-white/70">
              {profile.bio}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-white/50">
            <span className="tabular-nums">
              <span className="font-semibold text-white/80">
                {formatCount(profile.total_subscribers)}
              </span>{' '}
              สมาชิก
            </span>
            <span className="tabular-nums">
              <span className="font-semibold text-white/80">
                {formatCount(profile.total_followers)}
              </span>{' '}
              ผู้ติดตาม
            </span>
          </div>

          <p className="mt-4 rounded-xl border border-cyan-400/20 bg-cyan-500/8 px-4 py-3 text-sm leading-relaxed text-cyan-100/80">
            หน้าโปรไฟล์เต็มรูปแบบจะเปิดใช้งานเร็ว ๆ นี้
          </p>
        </div>
      </section>

      <h2 className="mb-4 mt-8 text-xl font-bold text-white">วิดีโอทั้งหมด</h2>

      {feed.error && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
        >
          {feed.error}
        </p>
      )}

      <PublicFeedGrid posts={feed.posts} loading={feed.loading} emptyReason="creator" />

      {feed.hasMore && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={feed.loadMore}
            disabled={feed.loadingMore}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-white/85 transition hover:bg-white/[0.08] disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            โหลดเพิ่ม
          </button>
        </div>
      )}
    </ViewerPageShell>
  );
}
