'use client';

/**
 * The body of /posts/[id]: playback or a lock, the creator, the description,
 * and the two engagement actions.
 *
 * Split out of the route file because that file has to stay a Server
 * Component — it is the only place `generateStaticParams` can live, which the
 * Capacitor `output: 'export'` build requires of every dynamic segment. Same
 * split as app/creator/posts/[id]/page.tsx.
 *
 * Which of the three states renders is decided by usePublicPost; see its
 * header for why entitlement cannot be read from `feed_posts` alone.
 */

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Eye, Heart, Loader2 } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { formatCount, formatRelativeThai } from '@/lib/creator/format';
import { usePublicPost } from '@/lib/hooks/usePublicPost';
import { aspectClassFor, likePost, thumbnailFor } from '@/lib/viewer/publicFeed';
import type { PlaybackResult, PublicPost } from '@/lib/viewer/types';
import { PrismStar } from '@/components/star/PrismStar';
import { AccessLockCard, type LockType } from './AccessLockCard';
import { CreatorInlineCard } from './CreatorInlineCard';
import { DeferredCta } from './DeferredCta';
import { PublicVideoPlayer } from './PublicVideoPlayer';
import { ViewerPageShell } from './ViewerPageShell';

const TIP_NOTICE = 'ระบบทิปจะเปิดใช้งานเร็ว ๆ นี้';

export function PublicPostView({ postId }: { postId: string }) {
  const { post, playback, plans, loading, error, notFound, refresh } = usePublicPost(postId);

  if (loading) {
    return (
      <ViewerPageShell title="กำลังโหลด..." width="detail" backHref="/discover" backLabel="กลับไปที่ค้นพบ" bare>
        <div className="h-96 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      </ViewerPageShell>
    );
  }

  if (notFound) {
    // Rendered in place rather than bounced with a toast: this repo has no
    // shared toast system and the brief forbids adding one, and a message on
    // the screen the viewer is looking at beats a redirect that leaves them
    // wondering what happened.
    return (
      <ViewerPageShell title="ไม่พบโพสต์" width="detail" backHref="/discover" backLabel="กลับไปที่ค้นพบ">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
          <p className="text-base font-semibold text-white">ไม่พบโพสต์นี้</p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">
            โพสต์อาจถูกลบไปแล้ว หรือยังไม่ถูกเผยแพร่
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

  // Title, creator and stats can all come from the metadata row — except when
  // RLS hid it, in which case the playback denial is the only source, and it
  // carries a title but no creator. Both paths are handled below.
  const denied = playback?.kind === 'denied' ? playback.playback : null;
  const title = post?.title?.trim() || denied?.title?.trim() || 'ไม่มีชื่อ';

  return (
    <ViewerPageShell title={title} width="detail" backHref="/discover" backLabel="กลับไปที่ค้นพบ" bare>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
        >
          {error}
        </p>
      )}

      {/* 65 / 35 on desktop, stacked on mobile, per the brief. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,65fr)_minmax(0,35fr)]">
        <div className="min-w-0">
          <PlaybackSection
            postId={postId}
            post={post}
            playback={playback}
            plans={plans}
            onRetry={refresh}
          />

          <section className="mt-5">
            <h1 className="bg-gradient-to-r from-purple-300 to-cyan-300 bg-clip-text text-xl font-bold tracking-tight text-transparent sm:text-2xl">
              {title}
            </h1>
            <p className="mt-1 text-sm text-white/40">
              {formatRelativeThai(post?.published_at ?? post?.created_at ?? null)}
            </p>

            {post?.content?.trim() ? (
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-white/70">
                {post.content}
              </p>
            ) : null}
          </section>

          {post && <EngagementBar post={post} />}
        </div>

        <div className="min-w-0">
          {post && (
            <CreatorInlineCard
              creator={post.creator}
              // TODO(day-9): creator_profiles.total_subscribers is not selected
              // into CreatorSummary — the card only needs the five identity
              // fields elsewhere. It reads 0 until subscriptions ship anyway.
              subscriberCount={0}
            />
          )}
        </div>
      </div>
    </ViewerPageShell>
  );
}

/** Player, lock card, encoding notice, or a retryable error. */
function PlaybackSection({
  postId,
  post,
  playback,
  plans,
  onRetry,
}: {
  postId: string;
  post: PublicPost | null;
  playback: PlaybackResult | null;
  plans: ReturnType<typeof usePublicPost>['plans'];
  onRetry: () => void;
}) {
  // The metadata row is the better source, but RLS hides it for a locked post
  // — in which case the only shape hint left is whatever playback returned.
  const playbackAspect = playback?.kind === 'allowed' ? playback.playback.aspect_ratio : null;
  const aspectClass = aspectClassFor(post?.aspect_ratio ?? playbackAspect);

  // A post whose encode has not finished: said from the metadata, without
  // spending a round trip on a call that can only answer 409.
  if (post && post.video_status !== 'ready') {
    return (
      <section className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
        <Loader2 size={30} className="animate-spin text-cyan-300" aria-hidden />
        <p className="mt-3 text-base font-semibold text-white" role="status">
          วิดีโอนี้ยังไม่พร้อมรับชม
        </p>
        <p className="mt-1 text-sm text-white/50">กำลังประมวลผล กรุณากลับมาใหม่อีกครั้ง</p>
      </section>
    );
  }

  if (playback?.kind === 'allowed') {
    return (
      <PublicVideoPlayer
        src={playback.playback.playback_url}
        poster={playback.playback.thumbnail_url ?? (post ? thumbnailFor(post) : null)}
        aspectRatio={playback.playback.aspect_ratio ?? post?.aspect_ratio ?? null}
        title={playback.playback.title}
      />
    );
  }

  if (playback?.kind === 'denied') {
    const denied = playback.playback;
    return (
      <AccessLockCard
        type={denied.access_level as LockType}
        postId={postId}
        title={denied.title}
        thumbnailUrl={denied.thumbnail_url ?? (post ? thumbnailFor(post) : null)}
        priceStars={post?.ppv_price_stars ?? null}
        creator={post?.creator ?? null}
        plans={plans}
        aspectClass={aspectClass}
      />
    );
  }

  // The gateway rejects an anonymous caller at 401 before the function runs,
  // so this is "not signed in", not "not allowed" — a login link, not a
  // paywall for content that might well be public to them once they are in.
  if (playback?.kind === 'error' && playback.error.code === 'unauthenticated') {
    return (
      <AccessLockCard
        type="anonymous"
        postId={postId}
        title={post?.title ?? null}
        thumbnailUrl={post ? thumbnailFor(post) : null}
        aspectClass={aspectClass}
      />
    );
  }

  return (
    <section className="rounded-2xl border border-rose-400/25 bg-rose-500/10 p-8 text-center">
      <AlertTriangle size={30} className="mx-auto text-rose-300" aria-hidden />
      <p className="mt-3 text-base font-semibold text-white">
        {playback?.kind === 'error' ? playback.error.message : 'เปิดวิดีโอไม่สำเร็จ กรุณาลองใหม่'}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        ลองใหม่อีกครั้ง
      </button>
    </section>
  );
}

/**
 * Views, likes, stars received, and the two actions on them.
 *
 * The like is optimistic and one-way. `increment_like_count` is a bare counter
 * with no per-user row, so there is nothing to un-like against and nothing
 * stopping a reload from liking again — the button disables itself after one
 * press so at least this page view counts once.
 * TODO(day-9): add per-user like tracking, then make this a real toggle.
 */
function EngagementBar({ post }: { post: PublicPost }) {
  const [likes, setLikes] = useState(post.like_count);
  const [liked, setLiked] = useState(false);

  async function like() {
    if (liked) return;
    setLiked(true);
    setLikes((n) => n + 1);

    let supabase;
    try {
      supabase = getBrowserSupabase();
    } catch {
      setLiked(false);
      setLikes((n) => Math.max(0, n - 1));
      return;
    }

    const stored = await likePost(supabase, post.id);
    // Trust the server's count when it answers, and roll back when it does
    // not — a heart that stays lit on a write that never landed is a lie.
    if (stored === null) {
      setLiked(false);
      setLikes((n) => Math.max(0, n - 1));
    } else {
      setLikes(stored);
    }
  }

  return (
    <section aria-label="การมีส่วนร่วม" className="mt-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-white/50">
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <Eye size={15} aria-hidden />
          {formatCount(post.view_count)} ครั้ง
        </span>
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <Heart size={15} aria-hidden />
          {formatCount(likes)}
        </span>
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          {/* TODO: swap to Variant C Deluxe when integrated. */}
          <PrismStar size={15} showChargeEffects={false} animated={false} aria-label="Stars" />
          {formatCount(post.tip_stars_received)}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={like}
          disabled={liked}
          aria-pressed={liked}
          className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
            liked
              ? 'border border-pink-400/30 bg-pink-500/15 text-pink-200'
              : 'border border-white/12 bg-white/[0.04] text-white/85 hover:bg-white/[0.08]'
          }`}
        >
          <Heart size={16} aria-hidden fill={liked ? 'currentColor' : 'none'} />
          {liked ? 'ถูกใจแล้ว' : 'ถูกใจ'}
        </button>

        <DeferredCta
          className="flex-1"
          variant="secondary"
          label="ให้ดาว"
          notice={TIP_NOTICE}
          icon={<PrismStar size={16} showChargeEffects={false} animated={false} aria-label="" />}
        />
      </div>
    </section>
  );
}
