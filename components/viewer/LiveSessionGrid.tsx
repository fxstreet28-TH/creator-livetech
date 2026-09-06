'use client';

/**
 * Cards for sessions that are on air, shared by /discover's live tab and the
 * dashboard's live strip.
 *
 * Each card is a link to /live/[id] now that the watch page exists. It stays an
 * <article> inside the <Link> rather than becoming one: the card carries a
 * title, a creator and two counters, which is content with a heading, not a
 * bare control.
 *
 * A LOCKED CARD IS STILL A LINK. Subscribers-only and PPV lives are listed
 * here now (they used to be invisible — see fetchLiveSessions), and tapping one
 * goes to /live/[id] exactly as an open one does. That is the point: the watch
 * page answers with LiveAccessLockCard, which is where a viewer can actually
 * see what they would be subscribing to. A card that refused to be tapped
 * would advertise a broadcast and then offer no way in.
 */

import Link from 'next/link';
import { Lock } from 'lucide-react';
import { formatCount } from '@/lib/creator/format';
import type { LiveSessionSummary } from '@/lib/viewer/types';
import { CreatorAvatar, creatorDisplayName } from './creatorDisplay';

export function LiveSessionGrid({ sessions }: { sessions: LiveSessionSummary[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {sessions.map((session) => (
        <LiveSessionCard key={session.id} session={session} />
      ))}
    </div>
  );
}

export function LiveSessionCard({ session }: { session: LiveSessionSummary }) {
  return (
    <Link
      href={`/live/${session.id}`}
      aria-label={
        session.is_locked
          ? `ไลฟ์เฉพาะสมาชิก: ${session.title}`
          : `เข้าชมไลฟ์: ${session.title}`
      }
      className="block rounded-2xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 hover:brightness-110"
    >
      <article className="relative aspect-video overflow-hidden rounded-2xl border border-white/10">
        {session.cover_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={session.cover_image_url}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-purple-600/40 via-[#1a1230] to-[#0d0b1e]" />
        )}

        <span className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-red-500/90 px-2 py-1 text-[11px] font-semibold text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          LIVE
        </span>

        <span className="absolute right-3 top-3 z-10 rounded-full bg-black/50 px-2 py-1 text-[11px] tabular-nums text-white backdrop-blur-sm">
          👁 {formatCount(session.current_viewer_count)}
        </span>

        {/* The cover is blurred as well as badged. A locked live's cover is
            the creator's own promotional image and is meant to be seen — but
            an unblurred one next to a lock reads as a mistake, and the blur is
            what makes "there is something here you do not have" legible at a
            glance in a grid. */}
        {session.is_locked && (
          <>
            <span
              className="absolute inset-0 z-[5] bg-black/45 backdrop-blur-[6px]"
              aria-hidden
            />
            <span className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 text-white">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-black/55 backdrop-blur-md">
                <Lock size={19} aria-hidden />
              </span>
              <span className="rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold backdrop-blur-md">
                {session.access_level === 'ppv' ? 'ซื้อเพื่อรับชม' : 'เฉพาะสมาชิก'}
              </span>
            </span>
          </>
        )}

        <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 to-transparent p-3">
          <p className="line-clamp-1 text-sm font-semibold text-white">{session.title}</p>
          <div className="mt-1.5 flex min-w-0 items-center gap-2">
            <CreatorAvatar creator={session.creator} size={24} />
            <span className="truncate text-xs text-white/70">
              {creatorDisplayName(session.creator)}
            </span>
            {session.creator.category && (
              <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70">
                {session.creator.category}
              </span>
            )}
          </div>
        </div>
      </article>
    </Link>
  );
}
