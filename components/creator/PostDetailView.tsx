'use client';

/**
 * The body of /creator/posts/[id]: preview, metadata, stats, edit and delete.
 *
 * Split out of the page because the route file has to stay a Server Component
 * — it is the only place `generateStaticParams` can live, which the Capacitor
 * `output: 'export'` build requires of every dynamic segment.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Eye, Heart, Loader2, MessageCircle, Pencil, Play, Trash2 } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { getPlaybackUrl } from '@/lib/creator/api';
import { visibilityEmoji, visibilityLabel } from '@/lib/creator/constants';
import {
  formatCount,
  formatDuration,
  formatFileSize,
  formatPostDateTime,
} from '@/lib/creator/format';
import { useCreatorPost } from '@/lib/hooks/useCreatorPost';
import type { CreatorPost } from '@/lib/creator/types';
import { PrismStar } from '@/components/star/PrismStar';
import { CreatorPageShell } from './CreatorPageShell';
import { DeletePostConfirm } from './DeletePostConfirm';
import { PostEditModal } from './PostEditModal';
import { PostStatusBadge } from './PostStatusBadge';

export function PostDetailView({ postId }: { postId: string }) {
  const router = useRouter();
  const { post, loading, error, notFound, refresh } = useCreatorPost(postId);

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Where to go after a delete — the upload page when the encode failed. */
  const [afterDelete, setAfterDelete] = useState('/creator/posts');

  if (loading) {
    return (
      <CreatorPageShell title="โพสต์" backHref="/creator/posts" backLabel="กลับไปที่โพสต์ของฉัน">
        <div className="h-72 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      </CreatorPageShell>
    );
  }

  if (notFound || !post) {
    // Rendered in place rather than bounced to /creator/posts with a toast:
    // this repo has no shared toast system and the brief is explicit about not
    // adding one, and a message on the screen the creator is looking at beats
    // a redirect that leaves them wondering what happened.
    return (
      <CreatorPageShell title="ไม่พบโพสต์" backHref="/creator/posts" backLabel="กลับไปที่โพสต์ของฉัน">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
          <p className="text-base font-semibold text-white">ไม่พบโพสต์นี้</p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">
            โพสต์อาจถูกลบไปแล้ว หรือไม่ใช่โพสต์ของคุณ
          </p>
          <Link
            href="/creator/posts"
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            ดูโพสต์ทั้งหมด
          </Link>
        </div>
      </CreatorPageShell>
    );
  }

  return (
    <CreatorPageShell
      title={post.title?.trim() || 'ไม่มีชื่อ'}
      backHref="/creator/posts"
      backLabel="กลับไปที่โพสต์ของฉัน"
    >
      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </p>
      )}

      <VideoSection
        post={post}
        onDeleteAndReupload={() => {
          setAfterDelete('/creator/upload');
          setDeleting(true);
        }}
      />

      <section className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
        <div className="flex flex-wrap items-center gap-2">
          <PostStatusBadge publishStatus={post.publish_status} videoStatus={post.video_status} />
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/65">
            <span aria-hidden>{visibilityEmoji(post.access_level)}</span>
            {visibilityLabel(post.access_level)}
          </span>
        </div>

        <h2 className="mt-3 break-words text-lg font-bold text-white">
          {post.title?.trim() || 'ไม่มีชื่อ'}
        </h2>

        {post.content?.trim() ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-white/70">
            {post.content}
          </p>
        ) : (
          <p className="mt-2 text-sm text-white/35">ยังไม่มีคำอธิบาย</p>
        )}

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/8 pt-4 text-sm sm:grid-cols-3">
          <Detail label="ความยาว" value={formatDuration(post.duration_seconds)} />
          <Detail label="ขนาดไฟล์" value={formatFileSize(post.file_size_bytes)} />
          <Detail label="สัดส่วนภาพ" value={post.aspect_ratio ?? '—'} />
          <Detail label="อัปโหลดเมื่อ" value={formatPostDateTime(post.created_at)} />
          <Detail
            label="เผยแพร่เมื่อ"
            value={post.publish_status === 'published' ? formatPostDateTime(post.published_at) : '—'}
          />
        </dl>
      </section>

      <section
        aria-label="สถิติ"
        className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        <Stat icon={<Eye size={16} aria-hidden />} label="ยอดชม" value={formatCount(post.view_count)} />
        <Stat icon={<Heart size={16} aria-hidden />} label="ถูกใจ" value={formatCount(post.like_count)} />
        <Stat
          icon={<MessageCircle size={16} aria-hidden />}
          label="ความคิดเห็น"
          value={formatCount(post.comment_count)}
        />
        <Stat
          // TODO: swap to Variant C Deluxe when integrated.
          icon={<PrismStar size={17} showChargeEffects={false} animated={false} aria-label="Stars" />}
          label="Stars ที่ได้รับ"
          value={formatCount(post.tip_stars_received)}
        />
      </section>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/85 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <Pencil size={16} aria-hidden />
          แก้ไข
        </button>
        <button
          type="button"
          onClick={() => {
            setAfterDelete('/creator/posts');
            setDeleting(true);
          }}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <Trash2 size={16} aria-hidden />
          ลบ
        </button>
      </div>

      {editing && (
        <PostEditModal post={post} onClose={() => setEditing(false)} onSaved={refresh} />
      )}

      {deleting && (
        <DeletePostConfirm
          postId={post.id}
          postTitle={post.title}
          onClose={() => setDeleting(false)}
          // replace, not push: the deleted post's URL must not be one Back
          // press away, because returning to it can only show "ไม่พบโพสต์".
          onDeleted={() => router.replace(afterDelete)}
        />
      )}
    </CreatorPageShell>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-white/40">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-white/80">{value}</dd>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3 backdrop-blur-xl">
      <span className="flex items-center gap-1.5 text-white/45">
        {icon}
        <span className="text-[11px]">{label}</span>
      </span>
      <p className="mt-1 text-lg font-bold tabular-nums text-white">{value}</p>
    </div>
  );
}

/**
 * The preview at the top of the page: encoding spinner, failure notice, or a
 * poster the creator can click to play.
 *
 * The HLS URL is fetched on that click rather than on mount, for two reasons.
 * `content-get-playback-url` increments view_count as a side effect, so an
 * auto-fetch would have a creator inflating their own numbers by opening their
 * own post; and the manifest is only worth requesting once someone actually
 * wants to watch.
 *
 * The player is a bare <video src={hls}>: hls.js is not a dependency
 * (package.json checked) and adding one for a creator-side preview is not
 * Day 3-4's call — Safari and iOS play HLS natively, and browsers that cannot
 * are told so instead of being shown a silently dead player.
 * TODO(day-5): replace with the real player component.
 */
function VideoSection({
  post,
  onDeleteAndReupload,
}: {
  post: CreatorPost;
  onDeleteAndReupload: () => void;
}) {
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  /** Set when the <video> itself gives up — see the note below the player. */
  const [playbackUnsupported, setPlaybackUnsupported] = useState(false);

  const status = post.video_status;

  if (status === 'failed') {
    return (
      <section className="rounded-2xl border border-rose-400/25 bg-rose-500/10 p-6 text-center">
        <AlertTriangle size={32} className="mx-auto text-rose-300" aria-hidden />
        <p className="mt-3 text-base font-semibold text-white">ประมวลผลวิดีโอไม่สำเร็จ</p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/60">
          ไฟล์นี้อาจเสียหายหรืออยู่ในรูปแบบที่ระบบไม่รองรับ กรุณาลบแล้วอัปโหลดใหม่อีกครั้ง
        </p>
        <button
          type="button"
          onClick={onDeleteAndReupload}
          className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-rose-500 px-5 py-3 text-sm font-bold text-white transition hover:bg-rose-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <Trash2 size={16} aria-hidden />
          ลบและอัปโหลดใหม่
        </button>
      </section>
    );
  }

  if (status === null || status === 'pending' || status === 'uploading' || status === 'processing') {
    return (
      <section className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
        <Loader2 size={30} className="animate-spin text-cyan-300" aria-hidden />
        <p className="mt-3 text-base font-semibold text-white" role="status">
          กำลังประมวลผลวิดีโอ...
        </p>
        <p className="mt-1 text-sm text-white/50">
          โดยปกติใช้เวลา 2-5 นาที หน้านี้จะอัปเดตให้เองเมื่อเสร็จ
        </p>
      </section>
    );
  }

  if (status === 'deleted') {
    return (
      <section className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center text-sm text-white/55 backdrop-blur-xl">
        วิดีโอนี้ถูกลบออกจากระบบแล้ว
      </section>
    );
  }

  async function play() {
    setPlaybackError(null);
    setLoadingUrl(true);

    let supabase;
    try {
      supabase = getBrowserSupabase();
    } catch {
      setPlaybackError('ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง');
      setLoadingUrl(false);
      return;
    }

    const { data, error } = await getPlaybackUrl(supabase, post.id);
    setLoadingUrl(false);

    if (error || !data) {
      console.error('[PostDetailView] get-playback-url failed', error);
      setPlaybackError(error?.message ?? 'เปิดวิดีโอไม่สำเร็จ กรุณาลองใหม่');
      return;
    }
    setPlaybackUrl(data.playback_url);
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-black">
      <div className="relative aspect-video w-full">
        {playbackUrl ? (
          <video
            src={playbackUrl}
            poster={post.thumbnail_url ?? undefined}
            controls
            autoPlay
            playsInline
            // Reported after the fact rather than predicted from
            // canPlayType(): that probe needs `document`, which does not exist
            // during the prerender pass, so branching on it would render one
            // tree on the server and another on the client.
            onError={() => setPlaybackUnsupported(true)}
            className="h-full w-full bg-black"
          />
        ) : (
          <>
            {post.thumbnail_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={post.thumbnail_url} alt="" className="h-full w-full object-cover" />
            )}
            <button
              type="button"
              onClick={play}
              disabled={loadingUrl}
              className="absolute inset-0 grid place-items-center bg-black/35 transition hover:bg-black/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              aria-label="เล่นวิดีโอ"
            >
              <span className="grid h-16 w-16 place-items-center rounded-full bg-white/15 backdrop-blur">
                {loadingUrl ? (
                  <Loader2 size={26} className="animate-spin text-white" aria-hidden />
                ) : (
                  <Play size={26} className="translate-x-0.5 text-white" aria-hidden />
                )}
              </span>
            </button>
          </>
        )}
      </div>

      {playbackError && (
        <p role="alert" className="border-t border-white/10 px-4 py-3 text-sm text-rose-200">
          {playbackError}
        </p>
      )}

      {playbackUnsupported && (
        <p role="alert" className="border-t border-white/10 px-4 py-3 text-xs leading-relaxed text-white/50">
          เบราว์เซอร์นี้ยังเล่นตัวอย่าง HLS ไม่ได้ — ลองเปิดด้วย Safari หรือบนมือถือ
          ระบบเล่นวิดีโอเต็มรูปแบบจะมาในเร็ว ๆ นี้
        </p>
      )}
    </section>
  );
}
