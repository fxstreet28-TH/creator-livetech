/**
 * The card a creator screen becomes when the thing it exists to do cannot be
 * done right now — the month's videos are used up, storage is full, today's
 * live hours are spent, or the platform is not accepting new work.
 *
 * Defence in depth, not enforcement: `check_creator_can_upload` /
 * `check_creator_can_golive` refuse these cases server-side and the Edge
 * Functions answer 403 regardless of what this component renders. What it
 * buys is the round trip, and the difference between "อัปโหลดล้มเหลว" after
 * a creator has picked a 2 GB file and written a description, and being told
 * before they start.
 *
 * It replaces the form in place. Navigation to /creator/upload and
 * /creator/live is never blocked or redirected (non-negotiable #7) — the page
 * still loads, still explains itself, and still offers the two ways forward.
 */

import Link from 'next/link';
import { Ban, Clock, HardDrive, Lock, Video } from 'lucide-react';
import type { QuotaBlockKind } from '@/lib/creator/quota';

const ICONS: Record<QuotaBlockKind, typeof Video> = {
  videos: Video,
  storage: HardDrive,
  live_hours: Clock,
  account: Ban,
  platform: Lock,
};

interface QuotaBlockedNoticeProps {
  kind: QuotaBlockKind;
  /** Thai, renderable. */
  title: string;
  /** Thai, renderable. One or two sentences. */
  message: string;
  /**
   * False for the platform kill switch and for a throttled account: neither
   * is fixed by paying more, and a plan CTA on a system-wide outage reads as
   * an upsell for a problem the creator did not cause.
   */
  showUpgrade?: boolean;
}

export function QuotaBlockedNotice({
  kind,
  title,
  message,
  showUpgrade = true,
}: QuotaBlockedNoticeProps) {
  const Icon = ICONS[kind];

  return (
    <section
      role="status"
      className="rounded-2xl border border-amber-400/25 bg-amber-500/[0.08] p-8 text-center backdrop-blur-xl"
    >
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-amber-400/25 bg-amber-400/10">
        <Icon size={26} className="text-amber-200" aria-hidden />
      </span>

      <p className="mt-4 text-base font-bold text-white">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/60">{message}</p>

      <div className="mx-auto mt-6 flex max-w-sm flex-col gap-3 sm:flex-row">
        {showUpgrade && (
          <Link
            href="/settings/plan"
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            อัปเกรดแพ็กเกจ
          </Link>
        )}
        <Link
          href="/creator/quota"
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          ดูโควตา
        </Link>
      </div>
    </section>
  );
}
