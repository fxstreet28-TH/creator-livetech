'use client';

/**
 * The bench itself. Gated by the server component beside it — see its header
 * for why the environment check cannot live in this file.
 *
 * It builds a LiveViewerState by hand and renders LiveViewerMobile against it.
 * The state is the ONE thing that is fake: every component under it — the
 * players, GiftOverlay, GiftTray, LiveChat in its overlay variant, the
 * reaction rail, the composer — is the same code the live page mounts, so a
 * layout that works here works there.
 *
 * TWO THINGS IT CANNOT SHOW, and both are honest rather than mocked away:
 *
 *  - THE VIDEO. There is no broadcast, so the player renders its real
 *    "กำลังรอสัญญาณ" state over a black frame. That state is translucent, so
 *    the gift stage under it is dimmed rather than hidden; everything a viewer
 *    touches sits above it and is unaffected.
 *  - THE KEYBOARD. `visualViewport` reports one only when a real one opens.
 *    Focus the input on a device, or in a browser's device emulation with a
 *    virtual keyboard, to see the composer ride up.
 */

import { useCallback, useMemo, useState } from 'react';
import { LiveViewerMobile } from '@/components/live/mobile/LiveViewerMobile';
import { useViewerOrientation } from '@/lib/hooks/useIsMobileViewport';
import type { LiveViewerState } from '@/lib/hooks/useLiveViewer';
import type { UseLiveChannelResult } from '@/lib/hooks/useLiveChannel';
import type { LiveGiftEvent } from '@/lib/live/gifts';
import type { LiveChatEntry } from '@/lib/live/types';
import type { CreatorSummary } from '@/lib/viewer/types';

const SESSION_ID = 'dev-mobile-bench';

const CREATOR: CreatorSummary = {
  id: 'dev-creator',
  handle: 'aurum_por',
  display_name: 'อ.ปอ AURUM',
  category: 'การเงิน',
  avatar_url: null,
};

const CHAT: LiveChatEntry[] = [
  { id: 'c1', text: 'สวัสดีครับทุกคน', sender: 'somchai_2540', timestamp: 0, senderId: 'u1', isCreator: false, isSelf: false },
  { id: 'c2', text: 'วันนี้สอนอะไรครับ', sender: 'nok_investor', timestamp: 0, senderId: 'u2', isCreator: false, isSelf: false },
  { id: 'c3', text: 'เดี๋ยวเริ่มจากพื้นฐานก่อนนะครับ', sender: 'อ.ปอ AURUM', timestamp: 0, senderId: 'dev-creator', isCreator: true, isSelf: false },
  { id: 'c4', text: 'somchai_2540 ส่ง Stardust ×3', sender: 'ระบบ', timestamp: 0, senderId: null, isCreator: false, isSelf: false, giftRarity: 'basic' },
  { id: 'c5', text: 'รอเลยครับ 🔥', sender: 'คุณ', timestamp: 0, senderId: 'me', isCreator: false, isSelf: true },
];

/** Enough history that "expand" has something to scroll. */
const CHAT_HISTORY: LiveChatEntry[] = Array.from({ length: 24 }, (_, index): LiveChatEntry => ({
  id: `h${index}`,
  text: `ข้อความทดสอบลำดับที่ ${index + 1} — ยาวพอที่จะได้เห็นการตัดบรรทัดในคอลัมน์แชท`,
  sender: index % 3 === 0 ? 'nok_investor' : 'somchai_2540',
  timestamp: 0,
  senderId: `u${index}`,
  isCreator: false,
  isSelf: false,
})).concat(CHAT);

/**
 * The three gifts worth looking at on this layout.
 *
 * 'tray' is what sits between the stage and the chat. 'nova' is the tallest
 * CSS tier, so it is the worst case for the stage's own height; 'clip' is a
 * tier-07 video card, whose 720 × 476 shape is the worst case for its WIDTH
 * and the reason the anchor carries a width cap at all.
 */
type BenchGift = 'tray' | 'nova' | 'clip';

function giftEvent(kind: BenchGift): LiveGiftEvent {
  if (kind === 'tray') {
    return {
      gift_id: `dev-tray-${Date.now()}`,
      session_id: SESSION_ID,
      tier_id: 1,
      tier_slug: 'stardust',
      name_en: 'Stardust',
      name_th: 'ผงดาว',
      rarity: 'basic',
      animation_key: 'stardust',
      display_mode: 'tray',
      duration_ms: 4500,
      sort_order: 1,
      quantity: 3,
      stars_total: 3,
      message: null,
      sender: { id: 'u1', display_name: 'somchai_2540', avatar_url: null },
      created_at: new Date().toISOString(),
    };
  }

  const clip = kind === 'clip';
  return {
    gift_id: `dev-${kind}-${Date.now()}`,
    session_id: SESSION_ID,
    tier_id: clip ? 7 : 4,
    tier_slug: clip ? 'tier-07' : 'nova',
    name_en: clip ? 'Tier 07' : 'Nova',
    name_th: clip ? 'ชั้น 07' : 'โนวา',
    rarity: clip ? 'mythic' : 'legendary',
    animation_key: clip ? 'video' : 'nova',
    display_mode: 'fullscreen',
    duration_ms: clip ? 42233 : 10000,
    sort_order: clip ? 7 : 4,
    quantity: 1,
    stars_total: clip ? 3000 : 100,
    message: 'สู้ ๆ นะครับอาจารย์',
    sender: { id: 'u1', display_name: 'somchai_2540', avatar_url: null },
    created_at: new Date().toISOString(),
  };
}

export function LiveMobileBench() {
  /**
   * A fixed start, chosen once when the bench mounts.
   *
   * `Date.now()` in the render body is an impure call — the clock moves under
   * a re-render and the elapsed pill would jitter — so the moment is captured
   * in state, which is also what keeps the screenshot reproducible.
   */
  const [startedAt] = useState(() => new Date(Date.now() - 761_000).toISOString());
  const [expandChat, setExpandChat] = useState(false);
  const [ended, setEnded] = useState(false);
  /**
   * Emulate an iPhone's safe areas.
   *
   * A desktop browser reports `env(safe-area-inset-*)` as 0 and there is no
   * way to set them — device emulation does not, and `env()` cannot be
   * overridden. The layout reads them through named variables for exactly this
   * reason (see LiveViewerMobile.module.css), so the bench can fill them in
   * and show what a notch and a home indicator actually do to the clearances.
   */
  const [notch, setNotch] = useState(true);
  /**
   * The real orientation, so the bench shows what a rotated handset shows.
   *
   * The live page gets this from useViewerLayoutMode, which also decides
   * mobile-vs-desktop; the bench has already decided that, so it reads the
   * orientation half on its own.
   */
  const orientation = useViewerOrientation();

  const [latestGift, setLatestGift] = useState<LiveGiftEvent | null>(null);
  const [toast, setToast] = useState<LiveViewerState['toast']>(null);

  const noop = useCallback(() => undefined, []);
  const sendChat = useCallback(async () => undefined, []);

  const channel = useMemo<UseLiveChannelResult>(
    () => ({
      chat: expandChat ? CHAT_HISTORY : CHAT,
      reactions: [],
      latestGift,
      gifts: [],
      viewerCount: 1204,
      chatMessageCount: CHAT.length,
      peakViewerCount: 1310,
      connected: true,
      status: 'connected',
      sendChat,
      sendReaction: noop,
    }),
    [expandChat, latestGift, noop, sendChat],
  );

  const state = useMemo<LiveViewerState>(
    () => ({
      session: {
        id: SESSION_ID,
        creator_id: CREATOR.id,
        room_name: SESSION_ID,
        title: 'พื้นฐานการลงทุนสำหรับมือใหม่',
        description: null,
        cover_image_url: null,
        access_level: 'public',
        ppv_price_stars: null,
        status: ended ? 'ended' : 'live',
        current_viewer_count: 1204,
        peak_viewer_count: 1310,
        tip_stars_received: 3420,
        started_at: startedAt,
        ended_at: null,
        broadcast_quality: '720p',
        latency_mode: 'low_latency',
      },
      creator: CREATOR,
      watch: ended
        ? { kind: 'ended' }
        : {
            kind: 'hls',
            // Deliberately unreachable: there is no broadcast, and the player's
            // own waiting state is what a viewer sees before one starts.
            playbackUrl: 'https://example.invalid/dev/playlist.m3u8',
            latencyMode: 'low_latency',
            creatorUserId: CREATOR.id,
          },
      loading: false,
      refresh: noop,
      title: 'พื้นฐานการลงทุนสำหรับมือใหม่',
      elapsedSeconds: 761,
      channel,
      endedWhileWatching: false,
      handleEnded: noop,
      giftOpen: false,
      openGift: noop,
      closeGift: noop,
      giftTiers: { tiers: [], loading: false, error: null, refresh: noop },
      balance: 250,
      handleSent: noop,
      toast,
      showToast: (message: string) => setToast({ message, key: Date.now() }),
      dismissToast: () => setToast(null),
    }),
    [channel, ended, noop, startedAt, toast],
  );

  return (
    <>
      {/*
        The layout declares its own safe-area variables on its root, so an
        inherited value from a wrapper would be shadowed — the override has to
        land on the same element, which only a stylesheet can do from out here.
        `!important` rather than a specificity trick because the order in which
        a dev-server style tag and a CSS module are inserted is not guaranteed.
      */}
      {notch && (
        <style>
          {orientation === 'landscape'
            ? // Held sideways the notch moves to a LONG edge: no top inset, a
              // short home-indicator strip, and 47px down each side. Emulating
              // the portrait numbers here would put a 59px band above a 375px
              // viewport and make the layout look broken when it is not.
              `[data-live-mobile-root]{--live-safe-top:0px!important;--live-safe-bottom:21px!important;--live-safe-left:47px!important;--live-safe-right:47px!important}`
            : `[data-live-mobile-root]{--live-safe-top:59px!important;--live-safe-bottom:34px!important}`}
        </style>
      )}

      <LiveViewerMobile sessionId={SESSION_ID} state={state} orientation={orientation} />

      {/* The bench's own controls, over everything the layout draws. They are
          the one thing on this page that does not exist on the real screen. */}
      <div
        data-bench-controls
        className="fixed left-1/2 top-1/2 z-[100] flex w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-wrap justify-center gap-1.5 rounded-xl bg-black/70 p-2 backdrop-blur-md"
      >
        <BenchButton onClick={() => setLatestGift(giftEvent('tray'))}>tray gift</BenchButton>
        <BenchButton onClick={() => setLatestGift(giftEvent('nova'))}>nova</BenchButton>
        <BenchButton onClick={() => setLatestGift(giftEvent('clip'))}>tier-07 clip</BenchButton>
        <BenchButton onClick={() => setExpandChat((on) => !on)}>
          {expandChat ? 'chat: history' : 'chat: 5 lines'}
        </BenchButton>
        <BenchButton onClick={() => setEnded((on) => !on)}>{ended ? 'ended' : 'live'}</BenchButton>
        <BenchButton onClick={() => setNotch((on) => !on)}>
          {notch ? 'safe areas: iPhone' : 'safe areas: none'}
        </BenchButton>
      </div>
    </>
  );
}

function BenchButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-white/15 bg-white/10 px-2 py-1 text-[11px] font-semibold text-white"
    >
      {children}
    </button>
  );
}
