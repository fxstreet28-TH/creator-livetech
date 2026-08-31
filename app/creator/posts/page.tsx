'use client';

/**
 * /creator/posts — everything this creator has uploaded, newest first.
 *
 * Reads feed_posts directly; RLS (`feed_posts_creator_own_all`) is what scopes
 * the rows to the caller. While anything is still encoding the list re-reads
 * on a timer so the badge flips on its own when the Bunny webhook lands — see
 * ENCODING_POLL_MS for why this is a poll and not a Realtime subscription.
 */

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useCreatorProfile } from '@/lib/hooks/useCreatorProfile';
import { useCreatorPosts } from '@/lib/hooks/useCreatorPosts';
import { CreatorPageShell } from '@/components/creator/CreatorPageShell';
import { PostListItem } from '@/components/creator/PostListItem';

export default function CreatorPostsPage() {
  const { ready } = useRequireAuth();
  const profile = useCreatorProfile();
  const { posts, loading, error, refresh } = useCreatorPosts(profile.creatorId);

  if (!ready) return <AuthPending />;

  const busy = profile.loading || loading;

  return (
    <CreatorPageShell
      title="โพสต์ของฉัน"
      subtitle="จัดการวิดีโอทั้งหมดของคุณ"
      width="form"
      action={
        <Link
          href="/creator/upload"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-purple-500 to-cyan-400 px-4 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <Plus size={16} aria-hidden />
          อัปโหลดใหม่
        </Link>
      }
    >
      {error && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={refresh}
            className="min-h-11 rounded-xl border border-rose-300/40 px-4 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            ลองใหม่อีกครั้ง
          </button>
        </div>
      )}

      {busy ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((key) => (
            <li
              key={key}
              className="h-[6.5rem] animate-pulse rounded-2xl border border-white/10 bg-white/5"
            />
          ))}
        </ul>
      ) : !profile.creatorId ? (
        <EmptyState
          title="คุณยังไม่ได้เป็น Creator"
          body="การอัปโหลดวิดีโอเปิดให้เฉพาะบัญชี Creator ที่ผ่านการตรวจสอบแล้ว"
          ctaHref="/creator/apply"
          ctaLabel="สมัครเป็น Creator"
        />
      ) : posts.length === 0 ? (
        <EmptyState
          title="ยังไม่มีโพสต์"
          body="อัปโหลดวิดีโอแรกของคุณ แล้วมันจะมาแสดงที่นี่"
          ctaHref="/creator/upload"
          ctaLabel="อัปโหลดวิดีโอ"
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {posts.map((post) => (
            <li key={post.id} className="min-w-0">
              <PostListItem post={post} />
            </li>
          ))}
        </ul>
      )}
    </CreatorPageShell>
  );
}

function EmptyState({
  title,
  body,
  ctaHref,
  ctaLabel,
}: {
  title: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
      <p className="text-base font-semibold text-white">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">{body}</p>
      <Link
        href={ctaHref}
        className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        {ctaLabel}
      </Link>
    </div>
  );
}
