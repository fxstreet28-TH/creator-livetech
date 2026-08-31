'use client';

/**
 * The body of /live/[sessionId]: the player, the chat, the creator, and the
 * four things that can happen instead of a live.
 *
 * Split out of the route file because that file has to stay a Server Component
 * — it is the only place `generateStaticParams` can live, which the Capacitor
 * `output: 'export'` build requires of every dynamic segment. Same split as
 * /posts/[id] (PostDetailGuard + PublicPostView).
 *
 * Which state renders is decided by useLiveWatch; see its header for why
 * entitlement cannot be read from `live_sessions` alone.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';
import { useLiveWatch } from '@/lib/hooks/useLiveWatch';
import type { Room } from '@/lib/live/livekitClient';
import { PrismStar } from '@/components/star/PrismStar';
import { CreatorInlineCard } from '@/components/viewer/CreatorInlineCard';
import { DeferredCta } from '@/components/viewer/DeferredCta';
import { ViewerPageShell } from '@/components/viewer/ViewerPageShell';
import {
  creatorDisplayName,
  creatorHandleLabel,
  creatorProfileHref,
} from '@/components/viewer/creatorDisplay';
import type { CreatorSummary } from '@/lib/viewer/types';
import { LiveAccessLockCard } from './LiveAccessLockCard';
import { LiveChat } from './LiveChat';
import { useElapsedSeconds } from './LiveStatsBar';
import { ViewerLivePlayer } from './ViewerLivePlayer';

const TIP_NOTICE = 'ระบบทิปจะเปิดใช้งานเร็ว ๆ นี้';

export function LiveWatchView({ sessionId }: { sessionId: string }) {
  const { session, creator, join, loading, refresh } = useLiveWatch(sessionId);
  const { displayName } = useDashboardUser();

  const [room, setRoom] = useState<Room | null>(null);
  /** Set when the room closes under us — the creator pressed "จบไลฟ์". */
  const [endedWhileWatching, setEndedWhileWatching] = useState(false);

  const elapsedSeconds = useElapsedSeconds(session?.started_at ?? null);
  const title = session?.title?.trim() || 'ไลฟ์สด';

  const handleEnded = useCallback(() => setEndedWhileWatching(true), []);

  if (loading) {
    return (
      <ViewerPageShell title="กำลังโหลด..." width="detail" backHref="/discover?tab=live" backLabel="กลับไปที่ไลฟ์" bare>
        <div className="h-96 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      </ViewerPageShell>
    );
  }

  if (join.kind === 'not_found') {
    return (
      <StatePanel
        heading="ไม่พบไลฟ์นี้"
        body="ไลฟ์อาจถูกลบไปแล้ว หรือลิงก์ไม่ถูกต้อง"
        creator={null}
      />
    );
  }

  if (join.kind === 'ended' || join.kind === 'cancelled') {
    return (
      <StatePanel
        heading={join.kind === 'ended' ? 'ไลฟ์นี้จบแล้ว' : 'ไลฟ์ถูกยกเลิก'}
        body={
          join.kind === 'ended'
            ? // Recording is post-launch: LiveKit egress is not wired, so there
              // is no video of a finished broadcast anywhere to offer.
              'ไม่มีการบันทึกไลฟ์นี้ — ติดตาม Creator ไว้เพื่อไม่พลาดไลฟ์ครั้งถัดไป'
            : 'Creator ยกเลิกไลฟ์นี้ก่อนเริ่มถ่ายทอด'
        }
        creator={creator}
      />
    );
  }

  if (join.kind === 'locked') {
    return (
      <ViewerPageShell title={title} width="detail" backHref="/discover?tab=live" backLabel="กลับไปที่ไลฟ์" bare>
        <LiveAccessLockCard
          type={join.level}
          title={session?.title ?? null}
          coverImageUrl={session?.cover_image_url ?? null}
          priceStars={session?.ppv_price_stars ?? null}
          creator={creator}
        />
      </ViewerPageShell>
    );
  }

  if (join.kind === 'error' || join.kind === 'pending') {
    return (
      <ViewerPageShell title="เข้าชมไลฟ์ไม่สำเร็จ" width="detail" backHref="/discover?tab=live" backLabel="กลับไปที่ไลฟ์">
        <section className="rounded-2xl border border-rose-400/25 bg-rose-500/10 p-8 text-center">
          <AlertTriangle size={30} className="mx-auto text-rose-300" aria-hidden />
          <p className="mt-3 text-base font-semibold text-white">
            {join.kind === 'error' ? join.message : 'เข้าชมไลฟ์ไม่สำเร็จ กรุณาลองใหม่'}
          </p>
          <button
            type="button"
            onClick={refresh}
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            ลองใหม่อีกครั้ง
          </button>
        </section>
      </ViewerPageShell>
    );
  }

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-[#0a0a15] text-white">
      <div className="safe-x safe-top grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        <div className="relative flex min-h-0 flex-col">
          <ViewerLivePlayer
            wsUrl={join.wsUrl}
            token={join.token}
            title={title}
            elapsedSeconds={elapsedSeconds}
            onRoomChange={setRoom}
            onEnded={handleEnded}
          />

          {endedWhileWatching && <EndedOverlay creator={creator} />}
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto lg:overflow-visible">
          {creator && (
            <div className="shrink-0">
              <CreatorInlineCard
                creator={creator}
                // TODO(post-launch): creator_profiles.total_subscribers is not
                // carried on CreatorSummary; it reads 0 until subscriptions
                // ship anyway. Same note as PublicPostView.
                subscriberCount={0}
                avatarSize={52}
              />
            </div>
          )}

          <DeferredCta
            className="shrink-0"
            variant="secondary"
            label="ให้ดาว"
            notice={TIP_NOTICE}
            icon={<PrismStar size={16} showChargeEffects={false} animated={false} aria-label="" />}
          />

          <LiveChat
            room={room}
            senderName={displayName || 'ผู้ชม'}
            isCreator={false}
            className="min-h-48 flex-1"
          />
        </div>
      </div>
    </main>
  );
}

/** "ไลฟ์จบแล้ว", painted over the player when the room closes mid-watch. */
function EndedOverlay({ creator }: { creator: CreatorSummary | null }) {
  const profileHref = creatorProfileHref(creator);
  const label = creatorHandleLabel(creator) ?? creatorDisplayName(creator);

  return (
    <div className="absolute inset-0 z-30 grid place-items-center rounded-2xl bg-black/85 px-6 text-center">
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
    </div>
  );
}

/**
 * The in-place answer for a session that cannot be watched at all.
 *
 * Rendered here rather than bounced with a toast, for the same reason
 * PublicPostView does it: this repo has no shared toast system and the brief
 * forbids adding one, and a message on the screen the viewer is looking at
 * beats a redirect that leaves them wondering what happened.
 */
function StatePanel({
  heading,
  body,
  creator,
}: {
  heading: string;
  body: string;
  creator: CreatorSummary | null;
}) {
  const profileHref = creatorProfileHref(creator);
  const label = creatorHandleLabel(creator) ?? creatorDisplayName(creator);

  return (
    <ViewerPageShell title={heading} width="detail" backHref="/discover?tab=live" backLabel="กลับไปที่ไลฟ์">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
        <p className="text-base font-semibold text-white">{heading}</p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">{body}</p>
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
    </ViewerPageShell>
  );
}
