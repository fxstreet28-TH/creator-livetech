'use client';
import { useState } from 'react';
import { Avatar } from './Avatar';
import { formatCompact, type MockCreator } from '@/lib/mockData';

export function CreatorCard({ creator }: { creator: MockCreator }) {
  const [following, setFollowing] = useState(false);

  return (
    <div className="rounded-2xl bg-[#14142b] p-5 text-center">
      <div className="flex justify-center">
        <Avatar name={creator.displayName} src={creator.avatarUrl} size={64} ring />
      </div>
      <p className="mt-3 font-semibold text-white">{creator.displayName}</p>
      <span className="mt-2 inline-block rounded-full bg-purple-500/20 px-2.5 py-1 text-xs text-purple-300">
        {creator.category}
      </span>
      <p className="mt-2 text-xs text-white/50">{formatCompact(creator.subscriberCount)} สมาชิก</p>
      <button
        type="button"
        onClick={() => setFollowing((v) => !v)}
        className={`mt-4 w-full rounded-xl py-3 text-sm font-semibold transition ${
          following
            ? 'border border-white/15 bg-white/5 text-white/70'
            : 'bg-gradient-to-r from-purple-500 to-pink-500 text-white hover:shadow-lg hover:shadow-purple-500/30'
        }`}
      >
        {following ? 'กำลังติดตาม' : 'ติดตาม'}
      </button>
    </div>
  );
}
