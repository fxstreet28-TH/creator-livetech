'use client';

/**
 * What /discover shows when the query came back with nothing.
 *
 * The copy is per-reason rather than one generic line: "ยังไม่มีเนื้อหา" is
 * true but useless on the "กำลังติดตาม" tab, where the fix is to follow
 * someone, and actively misleading on the live tab, where nothing is wrong at
 * all — live streaming has not shipped yet.
 */

import Link from 'next/link';
import { Compass, Heart, Radio } from 'lucide-react';

export type EmptyReason = 'feed' | 'following' | 'following_anonymous' | 'live' | 'creator';

interface Copy {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta?: { label: string; href: string };
}

const COPY: Record<EmptyReason, Copy> = {
  feed: {
    icon: <Compass size={30} aria-hidden />,
    title: 'ยังไม่มีเนื้อหาที่เผยแพร่',
    body: 'ยังไม่มี Creator คนไหนเผยแพร่วิดีโอ กลับมาดูใหม่เร็ว ๆ นี้ หรือเริ่มสร้างเนื้อหาของคุณเอง',
    cta: { label: 'สมัครเป็น Creator', href: '/creator/apply' },
  },
  following: {
    icon: <Heart size={30} aria-hidden />,
    title: 'ยังไม่มีเนื้อหาจากคนที่คุณติดตาม',
    body: 'ติดตาม Creator ที่คุณชอบ แล้ววิดีโอใหม่ ๆ ของพวกเขาจะมาโผล่ที่นี่',
    cta: { label: 'ไปดูเนื้อหาทั้งหมด', href: '/discover' },
  },
  following_anonymous: {
    icon: <Heart size={30} aria-hidden />,
    title: 'เข้าสู่ระบบเพื่อดูรายการติดตาม',
    body: 'เมื่อเข้าสู่ระบบแล้ว คุณจะเห็นวิดีโอใหม่จาก Creator ที่คุณติดตามได้ที่นี่',
    cta: { label: 'เข้าสู่ระบบ', href: '/login?redirect=/discover' },
  },
  live: {
    icon: <Radio size={30} aria-hidden />,
    title: 'ยังไม่มีไลฟ์ตอนนี้',
    body: 'ยังไม่มี Creator คนไหนกำลังไลฟ์ ลองกลับมาดูใหม่อีกครั้ง',
  },
  creator: {
    icon: <Compass size={30} aria-hidden />,
    title: 'Creator คนนี้ยังไม่มีวิดีโอที่เผยแพร่',
    body: 'เมื่อมีวิดีโอใหม่ จะแสดงที่นี่',
  },
};

export function FeedEmptyState({ reason = 'feed' }: { reason?: EmptyReason }) {
  const copy = COPY[reason];

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-purple-500/15 text-purple-200">
        {copy.icon}
      </span>
      <p className="mt-4 text-base font-semibold text-white">{copy.title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">{copy.body}</p>
      {copy.cta && (
        <Link
          href={copy.cta.href}
          className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          {copy.cta.label}
        </Link>
      )}
    </div>
  );
}
