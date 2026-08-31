'use client';

/**
 * One post in the viewer feed — thumbnail, access badge, title, creator, stats.
 *
 * The whole card is the link rather than a link inside a card, for the same
 * reason PostListItem is: on a phone the card is the tap target, and a title
 * link inside it leaves most of the card dead.
 */

import Link from 'next/link';
import { Eye, Heart, Play } from 'lucide-react';
import { formatCount, formatDuration, formatRelativeThai } from '@/lib/creator/format';
import { aspectClassFor, thumbnailFor } from '@/lib/viewer/publicFeed';
import type { PublicPost } from '@/lib/viewer/types';
import { PrismStar } from '@/components/star/PrismStar';
import { CreatorAvatar, creatorDisplayName, creatorHandleLabel } from './creatorDisplay';

export function PublicPostCard({ post }: { post: PublicPost }) {
  const thumbnail = thumbnailFor(post);
  const isLive = post.post_type === 'live_active';

  return (
    <Link
      href={`/posts/${post.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-purple-400/40 hover:shadow-lg hover:shadow-purple-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
    >
      <div
        className={`relative w-full shrink-0 overflow-hidden bg-gradient-to-br from-purple-600/35 to-cyan-500/25 ${aspectClassFor(post.aspect_ratio)}`}
      >
        {thumbnail ? (
          /* Plain <img>: the Bunny CDN host is not a next/image remote
             pattern, and the Capacitor build sets images.unoptimized, so
             next/image would add a wrapper and optimise nothing. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="grid h-full w-full place-items-center px-4 text-center text-sm text-white/45">
            <Play size={22} aria-hidden />
          </span>
        )}

        <AccessBadge post={post} />

        {isLive && (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full bg-red-500/90 px-2 py-1 text-[11px] font-semibold text-white">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            LIVE
          </span>
        )}

        {post.duration_seconds !== null && post.duration_seconds > 0 && (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/90">
            {formatDuration(post.duration_seconds)}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-3.5">
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-white">
          {post.title?.trim() || 'ไม่มีชื่อ'}
        </p>

        <div className="flex min-w-0 items-center gap-2">
          <CreatorAvatar creator={post.creator} size={32} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-medium text-white/85">
              {creatorDisplayName(post.creator)}
            </span>
            {creatorHandleLabel(post.creator) && (
              <span className="truncate text-[11px] text-white/40">
                {creatorHandleLabel(post.creator)}
              </span>
            )}
          </div>
          {post.creator.category && (
            <span className="ml-auto shrink-0 rounded-full bg-purple-500/20 px-2 py-0.5 text-[10px] text-purple-200">
              {post.creator.category}
            </span>
          )}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/45">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Eye size={12} aria-hidden />
            {formatCount(post.view_count)}
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Heart size={12} aria-hidden />
            {formatCount(post.like_count)}
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            {/* TODO: swap to Variant C Deluxe when integrated. Charge effects
                off — they overflow their box, which is wrong in a dense row. */}
            <PrismStar size={13} showChargeEffects={false} animated={false} aria-label="Stars" />
            {formatCount(post.tip_stars_received)}
          </span>
          <span className="ml-auto">{formatRelativeThai(post.published_at ?? post.created_at)}</span>
        </div>
      </div>
    </Link>
  );
}

/**
 * Top-left pill saying why a post is gated.
 *
 * Public posts get nothing at all — a "🌍 สาธารณะ" badge on every card in a
 * feed that is almost entirely public is noise that makes the two badges that
 * matter harder to spot.
 */
function AccessBadge({ post }: { post: PublicPost }) {
  if (post.access_level === 'subscribers') {
    return (
      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-purple-500/85 px-2 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
        <span aria-hidden>💜</span>
        สมาชิก
      </span>
    );
  }

  if (post.access_level === 'ppv') {
    return (
      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-400/90 to-pink-500/90 px-2 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
        <PrismStar size={12} showChargeEffects={false} animated={false} aria-label="Stars" />
        {post.ppv_price_stars !== null
          ? `ปลดล็อก ${formatCount(post.ppv_price_stars)} ดาว`
          : 'ปลดล็อก'}
      </span>
    );
  }

  if (post.access_level === 'free_preview') {
    return (
      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-cyan-500/80 px-2 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
        <span aria-hidden>👀</span>
        ตัวอย่างฟรี
      </span>
    );
  }

  return null;
}
