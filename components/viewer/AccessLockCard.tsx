'use client';

/**
 * What /posts/[id] renders instead of a player when the viewer is not
 * entitled: the thumbnail they are missing, why it is locked, and the CTA that
 * would unlock it.
 *
 * Everything here is driven by the 403 body from content-get-playback-url,
 * not by a feed_posts read. The live `feed_posts_public_read` policy filters
 * out every non-public post, so a locked post has no readable row for an
 * un-entitled viewer — the Edge Function, which runs as the service role, is
 * the only source of the title and thumbnail behind the lock. See the header
 * of lib/viewer/publicFeed.ts.
 *
 * The CTAs are deliberately inert: the subscribe and PPV purchase flows are
 * Day 8. See DeferredCta.
 */

import Link from 'next/link';
import { LogIn, Lock, Sparkles } from 'lucide-react';
import { formatCount } from '@/lib/creator/format';
import { PPV_THB_PER_STAR } from '@/lib/creator/constants';
import { PrismStar } from '@/components/star/PrismStar';
import { DeferredCta } from './DeferredCta';
import { creatorDisplayName, creatorHandleLabel } from './creatorDisplay';
import type { AccessLevel, CreatorSummary, SubscriptionPlanSummary } from '@/lib/viewer/types';

/**
 * 'anonymous' is not an access_level — it is the 401 the Edge Function's
 * gateway returns before any entitlement is even checked, which for a viewer
 * means "log in", not "pay". Folding it in here keeps /posts/[id] branching on
 * one component instead of two.
 */
export type LockType = Extract<AccessLevel, 'subscribers' | 'ppv' | 'free_preview' | 'public'> | 'anonymous';

interface AccessLockCardProps {
  type: LockType;
  postId: string;
  title: string | null;
  thumbnailUrl: string | null;
  /** Null when no ppv_posts row carries a price yet. */
  priceStars?: number | null;
  creator?: CreatorSummary | null;
  /** The creator's active plans. Empty until the plan UI ships on Day 8. */
  plans?: SubscriptionPlanSummary[];
  aspectClass?: string;
}

const SUBSCRIBE_NOTICE = 'ระบบสมัครสมาชิกจะเปิดใช้งานเร็ว ๆ นี้';
const UNLOCK_NOTICE = 'ระบบปลดล็อกด้วย Stars จะเปิดใช้งานเร็ว ๆ นี้';

export function AccessLockCard({
  type,
  postId,
  title,
  thumbnailUrl,
  priceStars = null,
  creator = null,
  plans = [],
  aspectClass = 'aspect-video',
}: AccessLockCardProps) {
  const creatorLabel = creatorHandleLabel(creator) ?? creatorDisplayName(creator);

  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl">
      {/* The preview the viewer is missing, blurred and dimmed behind the
          lock: enough to judge whether it is worth unlocking, not enough to
          be the content. */}
      <div className={`relative w-full overflow-hidden bg-black ${aspectClass}`}>
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt=""
            className="h-full w-full scale-105 object-cover blur-[6px] brightness-50"
          />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-purple-700/40 to-cyan-600/25" />
        )}

        <div className="absolute inset-0 grid place-items-center bg-black/35 p-6 text-center">
          <div>
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-white/12 text-white backdrop-blur">
              {type === 'anonymous' ? (
                <LogIn size={26} aria-hidden />
              ) : (
                <Lock size={26} aria-hidden />
              )}
            </span>
            {title?.trim() && (
              <p className="mt-4 line-clamp-2 text-base font-bold text-white">{title}</p>
            )}
          </div>
        </div>
      </div>

      <div className="p-5 sm:p-6">
        <LockBody
          type={type}
          postId={postId}
          priceStars={priceStars}
          creatorLabel={creatorLabel}
          plans={plans}
        />
      </div>
    </section>
  );
}

function LockBody({
  type,
  postId,
  priceStars,
  creatorLabel,
  plans,
}: {
  type: LockType;
  postId: string;
  priceStars: number | null;
  creatorLabel: string;
  plans: SubscriptionPlanSummary[];
}) {
  if (type === 'anonymous') {
    return (
      <>
        <h2 className="text-center text-base font-bold text-white">กรุณาเข้าสู่ระบบเพื่อรับชม</h2>
        <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-white/55">
          เข้าสู่ระบบแล้วกลับมาที่หน้านี้ได้ทันที
        </p>
        <Link
          href={`/login?redirect=${encodeURIComponent(`/posts/${postId}`)}`}
          className="mx-auto mt-5 flex min-h-11 w-full max-w-xs items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <LogIn size={16} aria-hidden />
          เข้าสู่ระบบ
        </Link>
      </>
    );
  }

  if (type === 'ppv') {
    return (
      <>
        <h2 className="flex items-center justify-center gap-2 text-center text-base font-bold text-white">
          {priceStars !== null ? (
            <>
              ปลดล็อกด้วย {formatCount(priceStars)}
              {/* TODO: swap to Variant C Deluxe when integrated. */}
              <PrismStar size={18} showChargeEffects={false} animated={false} aria-label="ดาว" />
              ดาว
            </>
          ) : (
            'โพสต์นี้ต้องปลดล็อกก่อนรับชม'
          )}
        </h2>
        {priceStars !== null && (
          <p className="mt-1 text-center text-sm text-white/45">
            ประมาณ {formatCount(priceStars * PPV_THB_PER_STAR)} บาท
          </p>
        )}
        <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-white/55">
          ปลดล็อกครั้งเดียว รับชมได้ตลอด
        </p>
        <DeferredCta
          className="mx-auto mt-5 w-full max-w-xs"
          label="ปลดล็อกตอนนี้"
          notice={UNLOCK_NOTICE}
          icon={<Sparkles size={16} aria-hidden />}
        />
      </>
    );
  }

  // 'subscribers', and the two levels that should never reach a lock card
  // ('public' / 'free_preview' are granted to everyone by the Edge Function).
  // They fall through to the subscriber copy rather than to a blank card,
  // because a denial the UI cannot explain still has to say something.
  return (
    <>
      <h2 className="text-center text-base font-bold text-white">
        สำหรับสมาชิกของ {creatorLabel} เท่านั้น
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-white/55">
        สมัครสมาชิกเพื่อรับชมวิดีโอนี้และเนื้อหาสำหรับสมาชิกทั้งหมด
      </p>
      {plans.length > 0 && (
        <ul className="mx-auto mt-4 grid w-full max-w-sm gap-2">
          {plans.map((plan) => (
            <li
              key={plan.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm"
            >
              <span className="min-w-0 truncate text-white/85">{plan.name}</span>
              <span className="shrink-0 tabular-nums text-white/55">
                {plan.price_stars !== null
                  ? `${formatCount(plan.price_stars)} ดาว`
                  : `${formatCount(plan.price_thb)} บาท`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <DeferredCta
        className="mx-auto mt-5 w-full max-w-xs"
        label={`สมัครสมาชิก ${creatorLabel}`}
        notice={SUBSCRIBE_NOTICE}
        icon={<Sparkles size={16} aria-hidden />}
      />
    </>
  );
}
