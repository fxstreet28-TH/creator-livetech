'use client';

/**
 * /live/[sessionId] on a phone — the full-bleed "Design C" layout, upright or
 * on its side.
 *
 * A SIBLING of the desktop layout in LiveWatchView, not a replacement: under
 * 768px (or under 1024px in landscape) this renders and the grid does not,
 * with useLiveViewer holding the single copy of everything underneath.
 * Nothing here fetches, subscribes or sends; it is a second arrangement of
 * state the page already has.
 *
 * WHAT CHANGED, AND WHY IT IS A RE-LAYOUT RATHER THAN A REWRITE
 *
 * The stacked layout gave a 16:9 video about a third of a phone screen and
 * spent the rest on a creator card and a boxed chat panel — on a video product
 * whose audience is ~70% phones. So the video fills the viewport and
 * everything else becomes a translucent layer over it: the creator and the way
 * out at the top, the reaction rail down the right, gifts and chat up the
 * left, the composer along the bottom. Every one of those layers is an
 * EXISTING component with a second presentation.
 *
 * ROTATION IS A PROP, NOT A SECOND COMPONENT, and that is the load-bearing
 * decision in this file. The two orientations render the same elements in the
 * same order with different classes and numbers, so turning a phone sideways
 * is a re-render: the <video> keeps playing, hls.js keeps its buffer, and the
 * Realtime channel — which lives above this in useLiveViewer — never notices.
 * A separate landscape component would unmount all three.
 *
 * THE THREE THINGS THAT ARE GENUINELY HARD HERE
 *
 *  1. SAFE AREAS. This ships as a Capacitor webview with `viewport-fit=cover`,
 *     so the page paints under the notch and the home indicator. Every layer
 *     states its own `env(safe-area-inset-*)` clearance — see the stylesheet.
 *  2. THE KEYBOARD. iOS Safari does not resize the layout viewport when the
 *     keyboard opens, so `bottom: 0` is behind it. useKeyboardInset measures
 *     the difference and the bottom stack rides up by it.
 *  3. NOTHING MAY COVER THE CREATOR'S FACE. That is the centre of the frame.
 *     It is why the gift stage is anchored to the left just above the chat,
 *     why its size is capped against a fraction of the viewport rather than
 *     chosen freely, and why a landscape source is cropped from 30% down
 *     rather than from the middle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, Gift, Maximize2, Minimize2, Scan, Sparkles, X } from 'lucide-react';
import { formatCount, formatDuration } from '@/lib/creator/format';
import { allTiersFree } from '@/lib/live/gifts';
import type { ViewerOrientation } from '@/lib/hooks/useIsMobileViewport';
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
import { RailButton } from './RailButton';
import { useFullscreenLandscape } from './useFullscreenLandscape';
import { useKeyboardInset, useViewportWidth } from './useMobileViewport';
import { useViewerFit } from './useViewerFit';
import styles from './LiveViewerMobile.module.css';

/**
 * The chat column's top edge, as the stylesheet computes it. Everything the
 * gift layer is positioned against is stated relative to this one line, so the
 * gifts and the chat cannot end up with two opinions about where it is.
 */
const CHAT_TOP = 'var(--live-chat-top)';

/** How far above the chat column the gift block's bottom edge sits. */
const STAGE_CHAT_GAP_PX = 12;

/**
 * One tray row: a 105px mascot in 6px of padding, top and bottom.
 *
 * The portrait layout lifts the stage over exactly one of these while the tray
 * has anything in it. Two and three still stack into it — there is no
 * arrangement of a stage, three rows, five lines of chat and a composer that
 * fits in 812px — and the rare case is the right one to let overlap.
 */
const TRAY_ROW_PX = 117;

/** Clearance between the lifted stage and the tray row under it. */
const STAGE_TRAY_GAP_PX = 16;

/** `.anchor`'s own gap, between the stage and its caption. */
const STAGE_CAPTION_GAP_PX = 8;

/**
 * How much height the caption takes, by density.
 *
 * An allowance rather than a measurement: the caption is laid out by flow and
 * its height depends on the sender's name, so budgeting for the worst case is
 * what keeps the block's top under the cap for every gift rather than most of
 * them. Portrait is three lines at 12/11px; landscape is two, because
 * `caption: 'minimal'` drops the sender's message there.
 */
const CAPTION_PX = { portrait: 60, landscape: 34 } as const;

/**
 * THE CAP: the block's top may not rise above this fraction of the viewport.
 *
 * The creator is in the middle of the frame, and this is the number that keeps
 * a gift out of it. Applied by shrinking the stage, which is the only lever —
 * its bottom is already as low as the chat allows.
 *
 * PORTRAIT ONLY. The brief's landscape figure is 45%, and 45% of a 375px
 * viewport is 169px, which is 31px above the chat column — less than a
 * caption, before any stage at all. On that screen the constraint that
 * actually binds is the top bar, so that is what is used; the gift stays out
 * of the creator's way there by being in the left column, not by being low.
 */
const PORTRAIT_CAP_RATIO = 0.42;

/** Clearance between the gift block's top and whatever is above it. */
const CAP_GAP_PX = 8;

/** The stage never smaller than this, or the gift is a smudge. */
const STAGE_FLOOR_PX = { portrait: 120, landscape: 88 } as const;

interface LiveViewerMobileProps {
  sessionId: string;
  state: LiveViewerState;
  orientation: ViewerOrientation;
}

export function LiveViewerMobile({ sessionId, state, orientation }: LiveViewerMobileProps) {
  const { session, creator, watch, channel, title } = state;
  const router = useRouter();
  const landscape = orientation === 'landscape';

  const keyboardInset = useKeyboardInset();
  const viewportWidth = useViewportWidth();
  const { fit, toggleFit } = useViewerFit();
  const fullscreen = useFullscreenLandscape();

  const rootRef = useRef<HTMLDivElement | null>(null);

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
   * The two lines the gift stage has to fit between, measured.
   *
   * Both are positioned by CSS from `env(safe-area-inset-*)`, which JavaScript
   * cannot read — and the stage's SIZE has to be a number, because the
   * animations are authored at 300px and scaled by a factor (see
   * useStageScale). So the stylesheet puts a zero-size probe on the chat's top
   * line and this reads it back, rather than restating the same arithmetic in
   * two languages and watching them drift.
   */
  const [probeNode, setProbeNode] = useState<HTMLDivElement | null>(null);
  const [topBarNode, setTopBarNode] = useState<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState({ chatTopY: 0, topBarBottomY: 0, viewportH: 0 });

  useEffect(() => {
    if (!probeNode || !topBarNode) return;

    const measure = () => {
      const next = {
        chatTopY: Math.round(probeNode.getBoundingClientRect().top),
        topBarBottomY: Math.round(topBarNode.getBoundingClientRect().bottom),
        viewportH: window.innerHeight,
      };
      setMetrics((current) =>
        current.chatTopY === next.chatTopY &&
        current.topBarBottomY === next.topBarBottomY &&
        current.viewportH === next.viewportH
          ? current
          : next,
      );
    };

    measure();
    // The document resizes on rotation, on the browser chrome collapsing, and
    // on the keyboard opening where the platform resizes the layout viewport;
    // the top bar's own height changes between the one-row and two-row forms.
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    observer.observe(topBarNode);
    return () => observer.disconnect();
    // keyboardInset is a dependency because on iOS the layout viewport does
    // NOT resize, so nothing above would fire — the stack moves and the probe
    // moves with it, silently.
  }, [probeNode, topBarNode, keyboardInset, orientation]);

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
   * ⤢ — as big as the device will allow, sideways where that is permitted.
   *
   * Where there is no Fullscreen API (iOS Safari) the page is already as
   * full-bleed as a web page gets and there is no orientation lock to ask for,
   * so the honest answer is to say so through the page's own toast rather than
   * to have a button that silently does nothing.
   */
  const handleFullscreen = useCallback(() => {
    if (!fullscreen.supported) {
      state.showToast('หมุนเครื่องเพื่อดูแบบเต็มจอ');
      return;
    }
    void fullscreen.toggle(rootRef.current);
  }, [fullscreen, state]);

  /**
   * The gift geometry, handed to GiftOverlay outright.
   *
   * Stated rather than derived because this canvas is not a player in a grid:
   * the overlay measures the viewport, and a fraction of the viewport says
   * nothing about where the chat column and the composer are. See GiftAnchor.
   */
  const giftAnchor = useMemo<GiftAnchor>(() => {
    const viewportH = metrics.viewportH || (landscape ? 375 : 812);
    const chatTopY = metrics.chatTopY || viewportH * 0.7;

    // The block's bottom edge, and the ceiling its top may not cross.
    const stageBottomY = chatTopY - STAGE_CHAT_GAP_PX;
    const topBarFloorY = metrics.topBarBottomY + CAP_GAP_PX;
    const capTopY = landscape
      ? topBarFloorY
      : Math.max(viewportH * PORTRAIT_CAP_RATIO, topBarFloorY);

    const captionPx = landscape ? CAPTION_PX.landscape : CAPTION_PX.portrait;
    const budget = stageBottomY - capTopY - STAGE_CAPTION_GAP_PX - captionPx;

    const designMax = landscape
      ? Math.min(viewportWidth * 0.2, 132, viewportH * 0.55)
      : Math.min(viewportWidth * 0.46, 180);
    const floor = landscape ? STAGE_FLOOR_PX.landscape : STAGE_FLOOR_PX.portrait;
    const stagePx = Math.round(Math.max(floor, Math.min(designMax, budget)));

    return {
      // The same 14px the chat column uses, past the same safe area. In
      // landscape that inset is 47px of rounded corner and notch, so a bare
      // 14px would put the mascot under the hardware.
      left: 'calc(var(--live-safe-left, 0px) + 14px)',
      /**
       * The lifted position: clear of one tray row. Landscape has no lifted
       * position — 375px of height cannot hold a stage above a 117px row above
       * three lines of chat — so there the tray steps aside instead, the same
       * way it does on a desktop player.
       */
      bottom: landscape
        ? `calc(${CHAT_TOP} + ${STAGE_CHAT_GAP_PX}px)`
        : `calc(${CHAT_TOP} + ${STAGE_CHAT_GAP_PX + TRAY_ROW_PX + STAGE_TRAY_GAP_PX}px)`,
      /**
       * The resting position, and where the stage is for most of a broadcast:
       * 12px above the chat column, exactly as low as it can go. GiftOverlay
       * uses this whenever the tray is EMPTY — not on a timer and not against a
       * reserved slot, so the drop begins the moment the last row expires.
       */
      bottomWithoutTray: landscape ? undefined : `calc(${CHAT_TOP} + ${STAGE_CHAT_GAP_PX}px)`,
      stagePx,
      // A video card is 1.5x as wide as it is tall; without this it would be
      // drawn past the chat column it is supposed to sit above.
      maxWidthPx: stagePx,
      // The tray's rows sit ON the chat's top line: this is the line minus the
      // 12px of overlay inset the tray adds as padding under itself.
      trayBottom: CHAT_TOP,
      trayShift: landscape,
      // Below, not above: on this layout the space over the stage is the top
      // bar's, and the space under it is the gap the stage was just moved out
      // of.
      captionAbove: false,
      caption: landscape ? 'minimal' : 'compact',
    };
  }, [landscape, metrics.chatTopY, metrics.topBarBottomY, metrics.viewportH, viewportWidth]);

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
  const iconSize = landscape ? 14 : 17;

  const statusPill = (
    <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-black/45 py-1 pl-1 pr-2.5 backdrop-blur-md">
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
  );

  const viewerControls = (
    <div className="flex shrink-0 items-center gap-2">
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
  );

  return (
    <div
      ref={rootRef}
      // Named so /dev/live-mobile can fill in safe areas a desktop browser
      // reports as zero; nothing in the app styles against it.
      data-live-mobile-root
      className={`${styles.root} ${landscape ? styles.rootLandscape : ''}`}
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
            fit={fit}
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
            fit={fit}
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
      <div ref={setProbeNode} className={styles.chatTopProbe} aria-hidden />

      {/* --------------------------------------------------------- top bar */}
      <div ref={setTopBarNode} className={styles.topBar}>
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 max-w-[64%] items-center gap-2 rounded-full bg-black/45 p-1 pr-2 backdrop-blur-md">
            <CreatorLink profileHref={profileHref} name={displayName}>
              <CreatorAvatar creator={creator} size={landscape ? 28 : 34} ring />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold leading-tight text-white">
                  {displayName}
                </span>
                {meta && !landscape && (
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

          {/* One row on a phone held sideways, where two rows of chrome is a
              tenth of a 375px viewport. The status pill joins the capsule's
              line instead of starting a second one. */}
          {landscape && statusPill}

          <div className="ml-auto pt-0.5">{viewerControls}</div>
        </div>

        {!landscape && <div className="mt-2 flex">{statusPill}</div>}
      </div>

      {/* ----------------------------------------------------- reaction rail */}
      {!ended && (
        <div className={styles.rail}>
          <EmojiReactionButton
            onReact={channel.sendReaction}
            enabled={channel.connected}
            orientation="vertical"
            // The palette is unchanged; this rail sends the first four — three
            // on a phone held sideways, where the column is 375px tall and
            // shares it with a top bar and a composer.
            limit={landscape ? 3 : 4}
            compact={landscape}
          />
          <LiveShareButton title={title} compact={landscape} />

          <RailButton
            label={fit === 'cover' ? 'พอดีกรอบ (ไม่ครอบตัด)' : 'เต็มจอ (ครอบตัด)'}
            onClick={toggleFit}
            active={fit === 'contain'}
            compact={landscape}
          >
            <Scan size={iconSize} aria-hidden />
          </RailButton>

          <RailButton
            label={fullscreen.active ? 'ออกจากเต็มจอ' : 'ดูเต็มจอแนวนอน'}
            onClick={handleFullscreen}
            active={fullscreen.active}
            compact={landscape}
          >
            {fullscreen.active ? (
              <Minimize2 size={iconSize} aria-hidden />
            ) : (
              <Maximize2 size={iconSize} aria-hidden />
            )}
          </RailButton>
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
  const className =
    'flex min-w-0 items-center gap-2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400';

  if (!profileHref) {
    return <span className={className}>{children}</span>;
  }

  return (
    <Link href={profileHref} aria-label={`ดูโปรไฟล์ ${name}`} className={className}>
      {children}
    </Link>
  );
}
