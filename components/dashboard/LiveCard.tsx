'use client';
import { Avatar } from './Avatar';
import { formatCompact, type MockLiveSession } from '@/lib/mockData';

interface LiveCardProps {
  session: MockLiveSession;
  creatorName: string;
  creatorAvatar: string | null;
}

export function LiveCard({ session, creatorName, creatorAvatar }: LiveCardProps) {
  return (
    <button
      type="button"
      onClick={() => console.log('open live:', creatorName)}
      className="relative h-40 w-64 shrink-0 snap-start overflow-hidden rounded-2xl text-left transition hover:opacity-95"
    >
      {/* Placeholder thumbnail (no real thumbnails yet) */}
      <div className="absolute inset-0 bg-gradient-to-br from-purple-600/40 via-[#1a1230] to-[#0d0b1e]" />

      <span className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-red-500/90 px-2 py-1 text-[11px] font-semibold text-white">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
        LIVE
      </span>

      <span className="absolute right-3 top-3 z-10 rounded-full bg-black/50 px-2 py-1 text-[11px] text-white backdrop-blur-sm">
        👁 {formatCompact(session.viewerCount)}
      </span>

      <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent p-3">
        <Avatar name={creatorName} src={creatorAvatar} size={28} />
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-white">{creatorName}</span>
          <span className="text-white/40">・</span>
          <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70">
            {session.category}
          </span>
        </div>
      </div>
    </button>
  );
}
