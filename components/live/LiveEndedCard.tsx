'use client';

/**
 * "ไลฟ์จบแล้ว" — what the watch page shows once the broadcast is over.
 *
 * Its own file because both watch layouts render it and neither can import the
 * other: the desktop grid paints it over the player when a LiveKit room closes
 * mid-watch, and the phone layout puts it in the middle of the black ground
 * with the top bar still above it. Same words and the same two ways out, so a
 * viewer who rotates their phone at the wrong moment does not see the screen
 * change under them.
 */

import Link from 'next/link';
import {
  creatorDisplayName,
  creatorHandleLabel,
  creatorProfileHref,
} from '@/components/viewer/creatorDisplay';
import type { CreatorSummary } from '@/lib/viewer/types';

export function LiveEndedCard({ creator }: { creator: CreatorSummary | null }) {
  const profileHref = creatorProfileHref(creator);
  const label = creatorHandleLabel(creator) ?? creatorDisplayName(creator);

  return (
    <div>
      <p className="text-lg font-bold text-white">ไลฟ์จบแล้ว</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">
        ขอบคุณที่รับชม — ไลฟ์นี้ไม่มีการบันทึก
      </p>
      <div className="mt-5 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
        {profileHref && (
          <Link
            href={profileHref}
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            ดูโปรไฟล์ {label}
          </Link>
        )}
        <Link
          href="/discover?tab=live"
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-5 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          ดูไลฟ์อื่น
        </Link>
      </div>
    </div>
  );
}
