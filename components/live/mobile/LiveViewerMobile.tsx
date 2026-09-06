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
 *     and it is why the gift stage is anchored to the bottom left instead of
 *     being centred behind a dim, why the tray sits above the chat rather than
 *     in the corner, and why both the reaction rail and the gift stage are
 *     required to finish above 45% of the viewport. The stage's height is
 *     MEASURED against what is actually on screen — the chat column, and the
 *     tray when it has rows — rather than reserved; see `giftAnchor`.
 *
 * AND THE ONE THING THAT IS NOT NEGOTIABLE: THE VIDEO FILLS THE SCREEN.
 *
 * `object-fit: cover`, edge to edge, whatever shape the source is. A 16:9
 * desktop broadcast is cropped to the phone's 9:19.5 with its sides cut, the
 * way TikTok and IG Live show one — not letterboxed into a band with black
 * above and below it. The players used to letterbox a landscape source on
 * purpose; that is what the ⛶ button in the top bar is for now, and only when
 * the viewer asks.
 */

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, Gift, Maximize, Sparkles, X } from 'lucide-react';
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
import { HlsLivePlayer, type PlayerFit } from '../HlsLivePlayer';
import { LiveBadge } from '../LiveStatsBar';
import { LiveChat } from '../LiveChat';
import { LiveEndedCard } from '../LiveEndedCard';
import { LiveKitLivePlayer } from '../LiveKitLivePlayer';
import { GiftOverlay } from '../gifts/GiftOverlay';
import { useTopFromViewportBottom, type GiftAnchor } from '../gifts/useStageScale';
import { LiveShareButton } from './LiveShareButton';
import { useKeyboardInset, useViewportSize } from './useMobileViewport';
import styles from './LiveViewerMobile.module.css';

/**
 * Where the TRAY sits, measured up from the bottom of the SCREEN.
 *
 * The design's 238px from the bottom of a 375 × 812 iPhone: 192 here, plus the
 * 12px of overlay inset the tray adds as padding under itself, plus that
 * phone's 34px indicator. A clearance on top of the safe-area inset rather
 * than an absolute coordinate, so an Android phone with no home indicator gets
 * the same gap above the composer as an iPhone with one.
 *
 * THE STAGE HAS NO EQUIVALENT CONSTANT ANY MORE, and that is the fix. It used
 * to be a second fixed offset — `safe-bottom + 330px` — chosen to clear one
 * tray row whether or not a row existed. That is a reserved slot: with an
 * empty tray, which is most of a broadcast, every gift was drawn 330px up the
 * screen, over the middle of the frame and the creator's face. The stage is
 * now positioned against what is ACTUALLY on screen — see `giftAnchor`.
 */
const GIFT_TRAY_BOTTOM = 'calc(var(--live-safe-bottom, 0px) + 192px)';

/** The design's stage size: `min(52vw, 200px)`, as a number (see useStageScale). */
const GIFT_STAGE_MAX_PX = 200;
const GIFT_STAGE_VW = 0.52;
/** Floor, so a squeezed stage is still a gift rather than a smudge. */
const GIFT_STAGE_MIN_PX = 96;

/** The stage's bottom edge clears the chat column's top by this much. */
const GIFT_STAGE_OVER_CHAT_PX = 12;
/** ...and the tray's top by this much, whenever a row is on screen. */
const GIFT_STAGE_OVER_TRAY_PX = 16;

/**
 * The stage's top may never be above this fraction of the viewport.
 *
 * The centre of the frame is the creator's face; the rail already states the
 * same rule for itself. Enforced by SHRINKING the stage rather than by moving
 * it down, because moving it down would put it back over the chat it was just
 * positioned above.
 */
const GIFT_STAGE_TOP_LIMIT = 0.45;

/**
 * Room reserved under the stage for the caption, in px.
 *
 * The caption is laid out by flow, not by this number — it exists only so the
 * ceiling above is applied to the whole block (stage + gap + caption) rather
 * than to the stage alone. Three lines of the phone caption (12px sender, 11px
 * stars, 11px message) and the 6px gap measure 65px on a 375px screen; 68
 * leaves a little over, and `maxHeightPx` below is what makes the rule hold
 * anyway when a message wraps further than that.
 */
const GIFT_CAPTION_HEADROOM_PX = 68;

/**
 * What the chat column's top is assumed to be for the one frame before it has
 * been measured: composer, gap, five lines and the page inset on an iPhone.
 * A gift cannot arrive before the first effect in practice; this is only so
 * the first render is not built on a zero.
 */
const CHAT_TOP_FALLBACK_PX = 238;

interface LiveViewerMobileProps {
  sessionId: string;
  state: LiveViewerState;
}

export function LiveViewerMobile({ sessionId, state }: LiveViewerMobileProps) {
  const { session, creator, watch, channel, title } = state;
  const router = useRouter();

  const keyboardInset = useKeyboardInset();
  const { width: viewportWidth, height: viewportHeight } = useViewportSize();

  /**
   * How the video fills the screen. COVER by default, always.
   *
   * A 16:9 desktop broadcast is cropped to the phone's 9:19.5, sides cut —
   * which is what TikTok, IG Live and Shopee Live all do, and what this layout
   * failed to do while the players letterboxed a landscape source. `contain`
   * is reachable only through the ⛶ button in the top bar, and it is not
   * remembered: it is a look-at-the-whole-frame gesture, not a preference.
   */
  const [fit, setFit] = useState<PlayerFit>('cover');

  /**
   * The two measurements the gift stage is positioned against.
   *
   * `bottomStackNode` is the chat column and composer together; its top edge is
   * "the chat column top" the stage has to sit above. `trayTop` is reported by
   * GiftOverlay and is 0 whenever no tray row is rendered. Both are measured up
   * from the bottom of the viewport — see useTopFromViewportBottom.
   */
  const [bottomStackNode, setBottomStackNode] = useState<HTMLDivElement | null>(null);
  const chatTop = useTopFromViewportBottom(bottomStackNode);
  const [trayTop, setTrayTop] = useState(0);
  const handleTrayTop = useCallback((px: number) => setTrayTop(px), []);

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
   *
   * TWO RULES, AND NO RESERVED SLOT.
   *
   * With no tray row on screen the stage's bottom edge sits 12px above the
   * chat column's top. With one it sits 16px above the TRAY's top instead,
   * which is measured rather than assumed because a tray is one, two or three
   * rows tall depending on what has just been sent. The old single constant
   * held the stage at the taller of the two at all times, so the common case —
   * an empty tray — put a gift across the middle of the broadcast.
   *
   * The stage then SHRINKS to fit under the 45% ceiling. Moving it down
   * instead would put it back over the chat, and the ceiling is the rule that
   * keeps the creator's face clear; on a 375 × 812 phone this leaves about
   * 140px of stage with an empty tray and the floor with a full one.
   */
  const giftAnchor = useMemo<GiftAnchor>(() => {
    const bottomPx =
      trayTop > 0
        ? trayTop + GIFT_STAGE_OVER_TRAY_PX
        : (chatTop || CHAT_TOP_FALLBACK_PX) + GIFT_STAGE_OVER_CHAT_PX;

    // The ceiling, expressed the same way everything else here is: as a
    // distance UP from the bottom of the viewport — so `blockRoomPx` is how
    // tall the whole block may be before its top crosses the 45% line.
    const ceilingPx = (viewportHeight || 0) * (1 - GIFT_STAGE_TOP_LIMIT);
    const blockRoomPx = ceilingPx - bottomPx;

    const designPx = Math.min(
      GIFT_STAGE_MAX_PX,
      (viewportWidth || GIFT_STAGE_MAX_PX * 2) * GIFT_STAGE_VW,
    );
    const stagePx = Math.max(
      GIFT_STAGE_MIN_PX,
      viewportHeight > 0
        ? Math.min(designPx, blockRoomPx - GIFT_CAPTION_HEADROOM_PX)
        : designPx,
    );

    /*
      THE ONE CASE WHERE THE TWO RULES CANNOT BOTH HOLD, stated rather than
      hidden. A tray row is ~143px tall and the chat column's top is ~240px up
      on a 375 × 812 phone, so "16px above the tray" puts the stage's bottom
      edge at ~385px — and the 45% line is at ~447px. That leaves ~47px for a
      stage and its caption, which is less than the floor, and a gift squeezed
      into it would be a smudge nobody can identify.

      So the ceiling is enforced only where it is satisfiable — which is the
      common case, an empty tray — and with a row on screen the stage keeps its
      floor and clears it, for the four and a half seconds that row lives.
      Enforcing it there instead would trade a readable gift for a rule whose
      whole purpose (keep the middle of the frame clear) is already served by
      the stage being at the bottom of the screen.
    */
    const ceilingIsMeetable =
      viewportHeight > 0 && blockRoomPx >= GIFT_STAGE_MIN_PX + GIFT_CAPTION_HEADROOM_PX;

    return {
      left: '14px',
      bottom: `${Math.round(bottomPx)}px`,
      stagePx,
      // A video card is 1.5× as wide as it is tall; without this it would be
      // drawn past the chat column it is supposed to sit above.
      maxWidthPx: stagePx,
      maxHeightPx: ceilingIsMeetable ? Math.floor(blockRoomPx) : undefined,
      trayBottom: GIFT_TRAY_BOTTOM,
      // The stage is ABOVE the tray here, not in its corner, so there is
      // nothing for the tray to step aside from.
      trayShift: false,
    };
  }, [chatTop, trayTop, viewportWidth, viewportHeight]);

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
        onTrayTopChange={handleTrayTop}
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
            {/*
              ⛶ — the only way to a letterboxed picture, and it is off by
              default. A viewer who wants to read a slide or a chart on a
              landscape broadcast taps it; everyone else gets the cropped,
              edge-to-edge frame without knowing this exists.
            */}
            {watchable && !ended && (
              <button
                type="button"
                onClick={() => setFit((current) => (current === 'cover' ? 'contain' : 'cover'))}
                aria-pressed={fit === 'contain'}
                aria-label={fit === 'contain' ? 'ครอบเต็มจอ' : 'แสดงภาพเต็มเฟรม'}
                className={`inline-flex h-[30px] w-[30px] items-center justify-center rounded-full backdrop-blur-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                  fit === 'contain'
                    ? 'bg-white/85 text-black'
                    : 'bg-black/45 text-white hover:bg-black/65'
                }`}
              >
                <Maximize size={15} aria-hidden />
              </button>
            )}

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
        <div ref={setBottomStackNode} className={styles.bottomStack}>
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
