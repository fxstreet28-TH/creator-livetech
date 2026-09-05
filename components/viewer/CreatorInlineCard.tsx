'use client';

/**
 * The "who made this" panel beside a post: avatar, name, category, subscriber
 * count, and the two creator-level actions.
 *
 * Both actions are inert today. Follow/unfollow is deferred post-launch (the
 * `follows` table exists, the write does not), and "ดูโปรไฟล์" only renders as
 * a link when the creator actually has a handle — /c/[handle] resolves BY
 * handle, so a link built from a null one could only 404, and every creator
 * row in production has a null handle right now.
 */

import Link from 'next/link';
import { ExternalLink, UserPlus } from 'lucide-react';
import { formatCount } from '@/lib/creator/format';
import type { CreatorSummary } from '@/lib/viewer/types';
import { DeferredCta } from './DeferredCta';
import { CreatorAvatar, creatorDisplayName, creatorHandleLabel, creatorProfileHref } from './creatorDisplay';

/**
 * Exported because the phone watch layout says the same thing.
 *
 * Its follow control is a pill in the creator capsule rather than this card's
 * full-width button, and it reports the refusal through the page's toast
 * instead of an inline note — but the sentence has to be the same one, or the
 * two screens disagree about when a feature ships.
 */
export const FOLLOW_NOTICE = 'ระบบติดตามจะเปิดใช้งานเร็ว ๆ นี้';

interface CreatorInlineCardProps {
  creator: CreatorSummary;
  /** creator_profiles.total_subscribers. 0 until subscriptions ship. */
  subscriberCount?: number;
  avatarSize?: number;
}

export function CreatorInlineCard({
  creator,
  subscriberCount = 0,
  avatarSize = 72,
}: CreatorInlineCardProps) {
  const handle = creatorHandleLabel(creator);
  const profileHref = creatorProfileHref(creator);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <CreatorAvatar creator={creator} size={avatarSize} ring />
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-white">{creatorDisplayName(creator)}</p>
          {handle && <p className="truncate text-sm text-white/45">{handle}</p>}
          {creator.category && (
            <span className="mt-1.5 inline-block rounded-full bg-purple-500/20 px-2.5 py-1 text-[11px] text-purple-200">
              {creator.category}
            </span>
          )}
        </div>
      </div>

      <p className="mt-4 text-sm text-white/50">
        <span className="font-semibold tabular-nums text-white/80">
          {formatCount(subscriberCount)}
        </span>{' '}
        สมาชิก
      </p>

      <DeferredCta
        className="mt-4"
        label="ติดตาม"
        notice={FOLLOW_NOTICE}
        icon={<UserPlus size={16} aria-hidden />}
      />

      {profileHref && (
        <Link
          href={profileHref}
          className="mt-1 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/85 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <ExternalLink size={16} aria-hidden />
          ดูโปรไฟล์
        </Link>
      )}
    </section>
  );
}
