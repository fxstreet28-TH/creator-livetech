'use client';

/**
 * /live/[sessionId] on a phone — the full-bleed "Design C" layout.
 *
 * A SIBLING of the desktop layout in LiveWatchView, not a replacement: below
 * 768px this renders and the grid does not, and from 768px the reverse, with
 * useLiveViewer holding the single copy of everything underneath. Nothing here
 * fetches, subscribes or sends; it is a second arrangement of state the page
 * already has.
 *
 * WHAT CHANGED, AND WHY IT IS A RE-LAYOUT RATHER THAN A REWRITE
 *
 * The stacked layout gave a 16:9 video about a third of a phone screen and
 * spent the rest on a creator card and a boxed chat panel — on a video product
 * whose audience is ~70% phones, and against competitors who all put the
 * broadcast edge to edge. So the video fills the viewport and everything else
 * becomes a translucent layer over it: the creator and the way out at the top,
 * the reaction rail down the right, gifts and chat up the left, the composer
 * along the bottom.
 *
 * Every one of those layers is an EXISTING component with a second
 * presentation — the same players, the same GiftOverlay and GiftDrawer, the
 * same LiveChat with `variant="overlay"`, the same EmojiReactionButton turned
 * on its side. Nothing about gifts, chat, Realtime or the wallet is different
 * on a phone; only where it is drawn is.
 *
 * THE THREE THINGS THAT ARE GENUINELY HARD HERE
 *
 *  1. SAFE AREAS. This ships as a Capacitor webview with `viewport-fit=cover`,
 *     so the page paints under the notch and the home indicator. Every layer
 *     states its own `env(safe-area-inset-*)` clearance — see the stylesheet.
 *  2. THE KEYBOARD. iOS Safari does not resize the layout viewport when the
 *     keyboard opens, so `bottom: 0` is behind it. useKeyboardInset measures
 *     the difference and the bottom stack rides up by it.
 *  3. NOTHING MAY COVER THE CREATOR'S FACE. That is the centre of the frame,
 *     and it is why the gift stage is anchored to the left at a stated height
 *     instead of being centred behind a dim, why the tray sits above the chat
 *     rather than in the corner, and why the reaction rail is required to
 *     finish above 45% of the viewport.
 */

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, Gift, Sparkles, X } from 'lucide-react';
import { formatCount, formatDuration } from '@/lib/creator/format';
import { allTiersFree } from '@/lib/live/gifts';
import type { LiveViewerState } from '@/lib/hooks/useLiveViewer';
import {
  CreatorAvatar,
  creatorDisplayName,
  creatorHandleLabel,
  creatorProfileHref,
} from '@/components/viewer/creatorDisplay';
import { FOLLOW_NOTICE } from '@/components/viewer/CreatorInlineCard';
import { EmojiReactionButton } from '../EmojiReactionButton';
import { FloatingReactionsLayer } from '../FloatingReactionsLayer';
import { HlsLivePlayer } from '../HlsLivePlayer';
import { LiveBadge } from '../LiveStatsBar';
import { LiveChat } from '../LiveChat';
import { LiveEndedCard } from '../LiveEndedCard';
import { LiveKitLivePlayer } from '../LiveKitLivePlayer';
import { GiftOverlay } from '../gifts/GiftOverlay';
import type { GiftAnchor } from '../gifts/useStageScale';
import { LiveShareButton } from './LiveShareButton';
import { useKeyboardInset, useViewportWidth } from './useMobileViewport';
import styles from './LiveViewerMobile.module.css';

/**
 * Where the gift layers sit, measured up from the bottom of the SCREEN.
 *
 * The stack from the bottom up is: composer, chat column, tray, fullscreen
 * stage — each one clear of the last. Both figures are a clearance ON TOP of
 * the safe-area inset rather than an absolute coordinate, so an Android phone
 * with no home indicator gets the same gap above the composer as an iPhone
 * with one.
 *
 * THE TRAY is the design's 238px from the bottom of a 375 × 812 iPhone: 192
 * here, plus the 12px of overlay inset the tray adds as padding under itself,
 * plus that phone's 34px indicator.
 *
 * THE STAGE is 34px HIGHER than the design's 330px, and that is deliberate. A
 * tray row is 117px tall (a 105px mascot in 6px of padding), so a stage whose
 * bottom is only 92px above the tray's — which is what 330 and 238 are, as
 * absolute coordinates — is drawn straight through the first Stardust row.
 * Clearing one full row is what the numbers were trying to express, so that is
 * what this states. A second and third row still stack into it; there is no
 * arrangement of a 195px stage, three 117px rows, five lines of chat and a
 * composer that fits in 812px, and the design's own choice is that the rare
 * three-row case overlaps rather than the common one.
 */
const GIFT_STAGE_BOTTOM = 'calc(var(--live-safe-bottom, 0px) + 330px)';
const GIFT_TRAY_BOTTOM = 'calc(var(--live-safe-bottom, 0px) + 192px)';

/** The design's stage size: `min(52vw, 200px)`, as a number (see useStageScale). */
const GIFT_STAGE_MAX_PX = 200;
const GIFT_STAGE_VW = 0.52;
/** Floor, for the frame before the viewport has been measured. */
const GIFT_STAGE_MIN_PX = 120;

interface LiveViewerMobileProps {
  sessionId: string;
  state: LiveViewerState;
}

export function LiveViewerMobile({ sessionId, state }: LiveViewerMobileProps) {
  const { session, creator, watch, channel, title } = state;
  const router = useRouter();

  const keyboardInset = useKeyboardInset();
  const viewportWidth = useViewportWidth();

  /**
   * Whether the chat column is showing full history.
   *
   * Held here rather than inside LiveChat because the other half of the
   * gesture is not the chat's: tapping the video collapses it again, and the
   * video belongs to this component. Local and not persisted — expanding the
   * chat is a thing a viewer does for a moment, not a preference.
   */
  const [chatExpanded, setChatExpanded] = useState(false);

  /**
   * ✕ goes back where the viewer came from, and falls back to the live tab.
   *
   * `router.back()` alone does nothing on a page opened from a shared link,
   * which is how most viewers arrive at a live — the history entry it would
   * pop is not there.
   */
  const close = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    router.push('/discover?tab=live');
  }, [router]);

  const ended = state.endedWhileWatching || watch.kind === 'ended' || watch.kind === 'cancelled';
  const watchable = watch.kind === 'hls' || watch.kind === 'livekit';

  /**
   * The gift geometry, handed to GiftOverlay outright.
   *
   * Stated rather than derived because this canvas is not a player in a grid:
   * the overlay measures the viewport, and a fraction of the viewport says
   * nothing about where the chat column and the composer are. See GiftAnchor.
   */
  const giftAnchor = useMemo<GiftAnchor>(() => {
    const stagePx = Math.max(
      GIFT_STAGE_MIN_PX,
      Math.min(GIFT_STAGE_MAX_PX, (viewportWidth || GIFT_STAGE_MAX_PX * 2) * GIFT_STAGE_VW),
    );
    return {
      left: '14px',
      bottom: GIFT_STAGE_BOTTOM,
      stagePx,
      // A video card is 1.5× as wide as it is tall; without this it would be
      // drawn past the chat column it is supposed to sit above.
      maxWidthPx: stagePx,
      trayBottom: GIFT_TRAY_BOTTOM,
      // The stage is ABOVE the tray here, not in its corner, so there is
      // nothing for the tray to step aside from.
      trayShift: false,
    };
  }, [viewportWidth]);

  /**
   * What the player paints on top of itself: the rising emoji, and the gifts.
   *
   * The reaction BUTTONS are not in here, unlike the desktop layout — they are
   * page chrome on this screen, at the same z-level as the composer, so a
   * ten-second Nova cannot end up over them.
   */
  const playerOverlay = (
    <>
      <FloatingReactionsLayer reactions={channel.reactions} />
      <GiftOverlay
        latestGift={channel.latestGift}
        resetKey={sessionId}
        inset={12}
        anchor={giftAnchor}
      />
    </>
  );

  const giftsAreFree = allTiersFree(state.giftTiers.tiers);
  const profileHref = creatorProfileHref(creator);
  const displayName = creatorDisplayName(creator);
  const meta = creator?.category?.trim() || creatorHandleLabel(creator);

  return (
    <div
      // Named so /dev/live-mobile can fill in safe areas a desktop browser
      // reports as zero; nothing in the app styles against it.
      data-live-mobile-root
      className={styles.root}
      style={{ '--live-keyboard': `${keyboardInset}px` } as React.CSSProperties}
    >
      {/* ------------------------------------------------------------ video */}
      {watchable &&
        (watch.kind === 'hls' ? (
          <HlsLivePlayer
            playbackUrl={watch.playbackUrl}
            latencyMode={watch.latencyMode}
            title={title}
            elapsedSeconds={state.elapsedSeconds}
            viewerCount={channel.viewerCount}
            overlay={playerOverlay}
            presentation="fullbleed"
          />
        ) : (
          <LiveKitLivePlayer
            wsUrl={watch.wsUrl}
            token={watch.token}
            title={title}
            elapsedSeconds={state.elapsedSeconds}
            viewerCount={channel.viewerCount}
            overlay={playerOverlay}
            onEnded={state.handleEnded}
            presentation="fullbleed"
          />
        ))}

      {/* The video is replaced, not covered: the layout, the top bar and the
          way out all stay exactly where they were a second ago. */}
      {ended && (
        <div className="absolute inset-0 z-[16] grid place-items-center bg-black px-6 text-center">
          <LiveEndedCard creator={creator} />
        </div>
      )}

      <div className={styles.scrimTop} aria-hidden />
      {!ended && <div className={styles.scrimBottom} aria-hidden />}

      {/* --------------------------------------------------------- top bar */}
      <div className={styles.topBar}>
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 max-w-[64%] items-center gap-2 rounded-full bg-black/45 p-1 pr-2 backdrop-blur-md">
            <CreatorLink profileHref={profileHref} name={displayName}>
              <CreatorAvatar creator={creator} size={34} ring />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold leading-tight text-white">
                  {displayName}
                </span>
                {meta && (
                  <span className="block truncate text-[10px] leading-tight text-white/55">
                    {meta}
                  </span>
                )}
              </span>
            </CreatorLink>

            {/*
              The follow flow has not shipped — `follows` exists, the write does
              not — so this is the same deferred CTA the desktop creator card
              renders, in the shape the capsule has room for. The label is
              "+ ติดตาม" until it can be "ติดตามแล้ว".
            */}
            <button
              type="button"
              onClick={() => state.showToast(FOLLOW_NOTICE)}
              className="shrink-0 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 px-2.5 py-1 text-[11px] font-bold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              + ติดตาม
            </button>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-1 text-[11px] tabular-nums text-white backdrop-blur-md">
              <Eye size={12} aria-hidden />
              {formatCount(channel.viewerCount)}
              <span className="sr-only">คนกำลังรับชม</span>
            </span>
            <button
              type="button"
              onClick={close}
              aria-label="ปิดไลฟ์"
              className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md transition hover:bg-black/65 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              <X size={17} aria-hidden />
            </button>
          </div>
        </div>

        {/* LIVE · elapsed · stars — the three numbers the framed player draws
            in its own corners, which full-bleed does not. Once the broadcast
            is over the red pill goes: a stopped stream still saying LIVE is
            the single most misleading thing this bar could show, and the
            duration and the star total are still true. */}
        <div className="mt-2 flex">
          <span className="inline-flex items-center gap-2 rounded-full bg-black/45 py-1 pl-1 pr-2.5 backdrop-blur-md">
            {ended ? (
              <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold text-white/70">
                จบแล้ว
              </span>
            ) : (
              <LiveBadge />
            )}
            <span className="text-[11px] tabular-nums text-white/90">
              {formatDuration(state.elapsedSeconds)}
            </span>
            <span className="text-[11px] font-semibold tabular-nums text-amber-200">
              ⭐ {formatCount(session?.tip_stars_received ?? 0)}
            </span>
          </span>
        </div>
      </div>

      {/* ----------------------------------------------------- reaction rail */}
      {!ended && (
        <div className={styles.rail}>
          <EmojiReactionButton
            onReact={channel.sendReaction}
            enabled={channel.connected}
            orientation="vertical"
            // ❤️ 🔥 👏 😂. The palette is unchanged; this rail sends the first
            // four so it plus the share button finishes above the gift stage.
            limit={4}
          />
          <LiveShareButton title={title} />
        </div>
      )}

      {/* Mounted only while the chat is expanded, so it cannot eat the taps
          meant for the player's own play and unmute buttons. */}
      {chatExpanded && (
        <button
          type="button"
          aria-label="ย่อแชท"
          onClick={() => setChatExpanded(false)}
          className={styles.collapseCatcher}
        />
      )}

      {/* ------------------------------------------------- chat + composer */}
      {!ended && (
        <div className={styles.bottomStack}>
          <LiveChat
            entries={channel.chat}
            onSend={channel.sendChat}
            status={channel.status}
            variant="overlay"
            expanded={chatExpanded}
            onExpandedChange={setChatExpanded}
            className={styles.composer}
            listClassName={styles.chat}
            action={
              <>
                <button
                  type="button"
                  onClick={state.openGift}
                  aria-label="ส่งของขวัญ"
                  className="relative inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-amber-500 text-[#3b2708] shadow-[0_0_14px_rgba(251,191,36,0.7)] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 active:scale-95"
                >
                  <Gift size={19} aria-hidden />
                  {/* Data-driven, exactly like the drawer's own banner: while
                      every active tier costs nothing, say so where the thumb
                      is rather than only after the sheet is open. */}
                  {giftsAreFree && (
                    <span className="absolute -right-0.5 -top-0.5 rounded-full bg-emerald-400 px-1 text-[9px] font-bold leading-[14px] text-emerald-950">
                      ฟรี
                    </span>
                  )}
                </button>

                <Link
                  href={`/wallet/buy-stars?redirect=${encodeURIComponent(`/live/${sessionId}`)}`}
                  aria-label="เติมดาว"
                  className="inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-cyan-400 text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 active:scale-95"
                >
                  <Sparkles size={18} aria-hidden />
                </Link>
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * The avatar and name, as a link when the creator has a handle to link to.
 *
 * /c/[handle] resolves BY handle and every creator row in production still has
 * a null one, so a link built from it could only 404 — the same rule
 * creatorProfileHref states, applied to the capsule that replaced the desktop
 * card's "ดูโปรไฟล์" button.
 */
function CreatorLink({
  profileHref,
  name,
  children,
}: {
  profileHref: string | null;
  name: string;
  children: React.ReactNode;
}) {
  const className = 'flex min-w-0 items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded-full';

  if (!profileHref) {
    return <span className={className}>{children}</span>;
  }

  return (
    <Link href={profileHref} aria-label={`ดูโปรไฟล์ ${name}`} className={className}>
      {children}
    </Link>
  );
}
