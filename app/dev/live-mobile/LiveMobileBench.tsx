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
 * THE VIDEO IS REAL, AND IT IS LANDSCAPE ON PURPOSE.
 *
 * `public/dev/live-sample/` is a 1280 x 720 clip packaged as a short VOD HLS
 * playlist, so the player mounted here is the production one — HlsLivePlayer,
 * lib/live/hlsPlayer.ts, hls.js — attached to a real 16:9 source. That is the
 * only way to check the thing this layout is actually judged on: whether a
 * landscape broadcast fills a portrait phone edge to edge, or sits in a band
 * with black above and below it. The clip's own edges are colour-coded so a
 * letterbox cannot hide in a screenshot; see the README beside it.
 *
 * "video: none" switches back to the unreachable URL, which is how to see the
 * player's real "กำลังรอสัญญาณ" waiting state.
 *
 * THE ONE THING IT CANNOT SHOW is THE KEYBOARD: `visualViewport` reports one
 * only when a real one opens. Focus the input on a device, or in a browser's
 * device emulation with a virtual keyboard, to see the composer ride up.
 */

import { useCallback, useMemo, useState } from 'react';
import { LiveViewerMobile } from '@/components/live/mobile/LiveViewerMobile';
import type { LiveViewerState } from '@/lib/hooks/useLiveViewer';
import type { UseLiveChannelResult } from '@/lib/hooks/useLiveChannel';
import type { LiveGiftEvent } from '@/lib/live/gifts';
import type { LiveChatEntry } from '@/lib/live/types';
import type { CreatorSummary } from '@/lib/viewer/types';

const SESSION_ID = 'dev-mobile-bench';

/**
 * The 16:9 test broadcast, in two codecs — see public/dev/live-sample/README.md.
 *
 * VOD playlists rather than live ones. hls.js plays them identically; the
 * difference is only that they end, and nothing in this layout is positioned
 * against the live edge.
 *
 * WHY THERE ARE TWO. H.264 is what production streams and what every real
 * phone decodes, so it is the default. It is also what a stock Chromium build
 * — Playwright's, and therefore any screenshot taken in CI — cannot decode at
 * all: `MediaSource.isTypeSupported('video/mp4; codecs="avc1…"')` is false
 * there, hls.js attaches a MediaSource and no frame ever arrives, and a
 * screenshot of that is a black screen indistinguishable from the letterbox
 * it was taken to disprove. The VP9 fMP4 rendition is the same eight seconds
 * of the same frame, and it is what makes this bench's proof re-runnable
 * without a licensed browser build.
 */
const LANDSCAPE_H264 = '/dev/live-sample/index.m3u8';
const LANDSCAPE_VP9 = '/dev/live-sample/index-vp9.m3u8';

/** Deliberately unreachable, for the player's own waiting state. */
const NO_SOURCE = 'https://example.invalid/dev/playlist.m3u8';

/**
 * The rendition this browser can actually decode.
 *
 * Read once, lazily, and never on the server: `MediaSource` does not exist
 * there, and getting this wrong in either direction shows a black frame rather
 * than an error.
 */
function landscapeSource(): string {
  if (typeof MediaSource === 'undefined') return LANDSCAPE_H264;
  return MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
    ? LANDSCAPE_H264
    : LANDSCAPE_VP9;
}

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

function giftEvent(kind: 'tray' | 'fullscreen'): LiveGiftEvent {
  const tray = kind === 'tray';
  return {
    gift_id: `dev-${kind}-${Date.now()}`,
    session_id: SESSION_ID,
    tier_id: tray ? 1 : 4,
    tier_slug: tray ? 'stardust' : 'nova',
    name_en: tray ? 'Stardust' : 'Nova',
    name_th: tray ? 'ผงดาว' : 'โนวา',
    rarity: tray ? 'basic' : 'legendary',
    animation_key: tray ? 'stardust' : 'nova',
    display_mode: tray ? 'tray' : 'fullscreen',
    duration_ms: tray ? 4500 : 10000,
    sort_order: tray ? 1 : 4,
    quantity: tray ? 3 : 1,
    stars_total: tray ? 3 : 100,
    message: tray ? null : 'สู้ ๆ นะครับอาจารย์',
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
   * Which source the player is attached to. The landscape clip by default —
   * a black waiting state cannot show whether the video is letterboxed, which
   * is the whole reason this bench exists.
   */
  const [video, setVideo] = useState(true);
  /**
   * Resolved once, lazily — see landscapeSource.
   *
   * The server run of the initialiser has no `MediaSource` and answers H.264;
   * the client's answers for real. Nothing renders the URL, so the two
   * disagreeing is not a hydration mismatch — it reaches hls.js from an effect,
   * by which point the client's answer is the one that exists.
   */
  const [source] = useState(landscapeSource);

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
            playbackUrl: video ? source : NO_SOURCE,
            latencyMode: 'low_latency',
            creatorUserId: CREATOR.id,
            source: 'llhls',
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
    [channel, ended, noop, source, startedAt, toast, video],
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
        <style>{`[data-live-mobile-root]{--live-safe-top:59px!important;--live-safe-bottom:34px!important}`}</style>
      )}

      <LiveViewerMobile sessionId={SESSION_ID} state={state} />

      {/* The bench's own controls, over everything the layout draws. They are
          the one thing on this page that does not exist on the real screen. */}
      <div
        data-bench-controls
        className="fixed left-1/2 top-1/2 z-[100] flex w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-wrap justify-center gap-1.5 rounded-xl bg-black/70 p-2 backdrop-blur-md"
      >
        <BenchButton onClick={() => setLatestGift(giftEvent('tray'))}>tray gift</BenchButton>
        <BenchButton onClick={() => setLatestGift(giftEvent('fullscreen'))}>fullscreen gift</BenchButton>
        <BenchButton onClick={() => setExpandChat((on) => !on)}>
          {expandChat ? 'chat: history' : 'chat: 5 lines'}
        </BenchButton>
        <BenchButton onClick={() => setEnded((on) => !on)}>{ended ? 'ended' : 'live'}</BenchButton>
        <BenchButton onClick={() => setVideo((on) => !on)}>
          {video ? 'video: 16:9 sample' : 'video: none'}
        </BenchButton>
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
