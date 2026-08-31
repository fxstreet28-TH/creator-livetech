'use client';

/**
 * One post in /creator/posts — thumbnail, title, status, visibility, stats.
 *
 * The whole card is the link rather than a link inside a card: on a phone the
 * card is the tap target, and a 44px title link inside a 120px card leaves
 * most of it dead.
 */

import Link from 'next/link';
import { Eye, Heart, Play } from 'lucide-react';
import { formatCount, formatDuration, formatRelativeThai } from '@/lib/creator/format';
import { visibilityEmoji, visibilityLabel } from '@/lib/creator/constants';
import type { CreatorPost } from '@/lib/creator/types';
import { PrismStar } from '@/components/star/PrismStar';
import { PostStatusBadge } from './PostStatusBadge';

export function PostListItem({ post }: { post: CreatorPost }) {
  return (
    <Link
      href={`/creator/posts/${post.id}`}
      className="group flex gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 backdrop-blur-xl transition hover:border-purple-400/30 hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
    >
      <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-purple-600/35 to-cyan-500/25 sm:w-36">
        {post.thumbnail_url ? (
          /* Plain <img>: the Bunny CDN host is not configured as a next/image
             remote pattern, and the Capacitor build sets images.unoptimized,
             so next/image would add a wrapper and optimise nothing. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.thumbnail_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="grid h-full w-full place-items-center text-white/40">
            <Play size={20} aria-hidden />
          </span>
        )}

        {post.duration_seconds !== null && post.duration_seconds > 0 && (
          <span className="absolute bottom-1 right-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white/90">
            {formatDuration(post.duration_seconds)}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
        <div className="min-w-0">
          <p className="line-clamp-2 text-sm font-semibold leading-snug text-white">
            {post.title?.trim() || 'ไม่มีชื่อ'}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <PostStatusBadge publishStatus={post.publish_status} videoStatus={post.video_status} />
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/60">
              <span aria-hidden>{visibilityEmoji(post.access_level)}</span>
              {visibilityLabel(post.access_level)}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/45">
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
          <span className="ml-auto">{formatRelativeThai(post.created_at)}</span>
        </div>
      </div>
    </Link>
  );
}
