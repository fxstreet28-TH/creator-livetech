'use client';

/**
 * Cards for sessions that are on air, shared by /discover's live tab and the
 * dashboard's live strip.
 *
 * Not links yet: the watch page is Day 7-8, and a card that navigates to a
 * 404 is worse than one that does not navigate. The card is a plain <article>
 * until there is somewhere to go.
 */

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
  );
}
