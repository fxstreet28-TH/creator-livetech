'use client';

/**
 * What /live/[sessionId] renders instead of a player when the join function
 * refuses: a blurred cover, why the live is locked, and the CTA that would
 * unlock it.
 *
 * Not AccessLockCard. That component is driven by the 403 body from
 * content-get-playback-url, which carries a title and thumbnail; the live join
 * function's 403 carries neither — and, for a locked session, RLS hides the
 * `live_sessions` row that would (see fetchLiveSession's header). So this card
 * renders from whatever the caller managed to read, which for a PPV live is
 * usually nothing but the lock itself. Its links point at a creator profile
 * rather than at a post, and there is no `anonymous` case: the page is behind
 * useRequireAuth, so an unauthenticated viewer is redirected to /login before
 * any of this renders.
 *
 * The CTAs are inert, like every subscribe/PPV button in the app this sprint.
 * See DeferredCta.
 */

import Link from 'next/link';
import { Lock, Sparkles } from 'lucide-react';
import { formatCount } from '@/lib/creator/format';
import { PPV_THB_PER_STAR } from '@/lib/creator/constants';
import { PrismStar } from '@/components/star/PrismStar';
import { DeferredCta } from '@/components/viewer/DeferredCta';
import {
  creatorDisplayName,
  creatorHandleLabel,
  creatorProfileHref,
} from '@/components/viewer/creatorDisplay';
import type { CreatorSummary } from '@/lib/viewer/types';

const SUBSCRIBE_NOTICE = 'ระบบสมัครสมาชิกจะเปิดใช้งานเร็ว ๆ นี้';
const UNLOCK_NOTICE = 'ระบบปลดล็อกด้วย Stars จะเปิดใช้งานเร็ว ๆ นี้';

interface LiveAccessLockCardProps {
  type: 'subscribers' | 'ppv';
  title: string | null;
  coverImageUrl: string | null;
  /** Null when the row is unreadable, which for a PPV live is the normal case. */
  priceStars?: number | null;
  creator?: CreatorSummary | null;
}

export function LiveAccessLockCard({
  type,
  title,
  coverImageUrl,
  priceStars = null,
  creator = null,
}: LiveAccessLockCardProps) {
  const creatorLabel = creatorHandleLabel(creator) ?? creatorDisplayName(creator);
  const profileHref = creatorProfileHref(creator);

  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl">
      <div className="relative aspect-video w-full overflow-hidden bg-black">
        {coverImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverImageUrl}
            alt=""
            className="h-full w-full scale-105 object-cover blur-[6px] brightness-50"
          />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-purple-700/40 to-cyan-600/25" />
        )}

        <div className="absolute inset-0 grid place-items-center bg-black/35 p-6 text-center">
          <div>
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-white/12 text-white backdrop-blur">
              <Lock size={26} aria-hidden />
            </span>
            {title?.trim() && (
              <p className="mt-4 line-clamp-2 text-base font-bold text-white">{title}</p>
            )}
          </div>
        </div>
      </div>

      <div className="p-5 sm:p-6">
        {type === 'ppv' ? (
          <>
            <h2 className="flex flex-wrap items-center justify-center gap-2 text-center text-base font-bold text-white">
              {priceStars !== null ? (
                <>
                  ปลดล็อกด้วย {formatCount(priceStars)}
                  {/* TODO: swap to Variant C Deluxe when integrated. */}
                  <PrismStar size={18} showChargeEffects={false} animated={false} aria-label="ดาว" />
                  ดาว
                </>
              ) : (
                'ไลฟ์นี้ต้องปลดล็อกก่อนรับชม'
              )}
            </h2>
            {priceStars !== null && (
              <p className="mt-1 text-center text-sm text-white/45">
                ประมาณ {formatCount(priceStars * PPV_THB_PER_STAR)} บาท
              </p>
            )}
            <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-white/55">
              ปลดล็อกเพื่อรับชมไลฟ์นี้แบบสด
            </p>
            <DeferredCta
              className="mx-auto mt-5 w-full max-w-xs"
              label="ปลดล็อกตอนนี้"
              notice={UNLOCK_NOTICE}
              icon={<Sparkles size={16} aria-hidden />}
            />
          </>
        ) : (
          <>
            <h2 className="text-center text-base font-bold text-white">
              สมาชิกของ {creatorLabel} เท่านั้น
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-white/55">
              สมัครสมาชิกเพื่อรับชมไลฟ์นี้และเนื้อหาสำหรับสมาชิกทั้งหมด
            </p>
            <DeferredCta
              className="mx-auto mt-5 w-full max-w-xs"
              label={`สมัครสมาชิก ${creatorLabel}`}
              notice={SUBSCRIBE_NOTICE}
            />
          </>
        )}

        {profileHref && (
          <Link
            href={profileHref}
            className="mx-auto mt-3 flex min-h-11 w-full max-w-xs items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            ดูโปรไฟล์ {creatorLabel}
          </Link>
        )}
      </div>
    </section>
  );
}
