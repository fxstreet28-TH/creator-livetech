'use client';

/**
 * Everything /live/[sessionId] does that is not layout.
 *
 * The watch page has TWO presentations now — the desktop grid (video, creator
 * card, chat column) and the full-bleed phone layout — and they need exactly
 * the same things: the session and whether the viewer may watch it, the
 * Realtime channel that carries chat, reactions, presence and gifts, the gift
 * catalogue and wallet balance the drawer prices against, and the elapsed
 * clock. Lifting that here is what makes them two views of one page rather
 * than two pages: there is one entitlement check, one channel subscription and
 * one presence entry however the screen is arranged, and a viewer who rotates
 * a phone across the breakpoint does not rejoin anything.
 *
 * It composes hooks and holds the small pieces of state that survive between
 * them; it renders nothing and decides nothing about layout. Every early
 * return the page makes — locked, ended, not found — is still the page's, and
 * is made from `watch` below.
 *
 * Everything here was previously inline in LiveWatchView, in this order and
 * with these reasons; the comments came with it.
 */

import { useCallback, useState } from 'react';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';
import { useGiftTiers, type GiftTiersResult } from '@/lib/hooks/useGiftTiers';
import { useLiveChannel, type UseLiveChannelResult } from '@/lib/hooks/useLiveChannel';
import { useLiveWatch, type LiveWatchState } from '@/lib/hooks/useLiveWatch';
import { useWalletSummary } from '@/lib/hooks/useWalletSummary';
import { useElapsedSeconds } from '@/components/live/LiveStatsBar';
import type { FeedbackToastState } from '@/components/feedback/FeedbackToast';
import type { CreatorSummary } from '@/lib/viewer/types';
import type { LiveSessionDetail } from '@/lib/live/types';

export interface LiveViewerState {
  session: LiveSessionDetail | null;
  creator: CreatorSummary | null;
  watch: LiveWatchState;
  loading: boolean;
  refresh: () => void;

  /** The session's title, or a neutral fallback. Never empty. */
  title: string;
  /** Seconds since `started_at`, ticking. */
  elapsedSeconds: number;

  channel: UseLiveChannelResult;

  /** True once a LiveKit room has closed under us — the creator ended the live. */
  endedWhileWatching: boolean;
  /** Handed to the LiveKit player as its `onEnded`. */
  handleEnded: () => void;

  giftOpen: boolean;
  openGift: () => void;
  closeGift: () => void;
  giftTiers: GiftTiersResult;
  /** Stars available to spend, or null while the wallet read is in flight. */
  balance: number | null;
  /** Handed to GiftDrawer as its `onSent`. */
  handleSent: (walletBalance: number) => void;

  toast: FeedbackToastState | null;
  showToast: (message: string) => void;
  dismissToast: () => void;
}

export interface UseLiveViewerOptions {
  /**
   * Read the gift catalogue once the channel is up, without waiting for the
   * drawer to be opened.
   *
   * useGiftTiers is lazy on purpose — a live page already makes several calls
   * before the video plays, and the catalogue is only needed the moment
   * somebody decides to spend. The phone layout asks for it anyway because it
   * shows a "ฟรี" tag on the gift button while every active tier costs
   * nothing, and a badge that only appears after you have already opened the
   * sheet is a badge that never did its job.
   *
   * Gated on the channel being connected rather than on mount, so it still
   * queues behind the things the viewer actually came for.
   */
  preloadGiftTiers?: boolean;
}

export function useLiveViewer(
  sessionId: string,
  { preloadGiftTiers = false }: UseLiveViewerOptions = {},
): LiveViewerState {
  const { session, creator, watch, loading, refresh } = useLiveWatch(sessionId);
  const { user, displayName } = useDashboardUser();

  /** Set when a LiveKit room closes under us — the creator pressed "จบไลฟ์". */
  const [endedWhileWatching, setEndedWhileWatching] = useState(false);

  const elapsedSeconds = useElapsedSeconds(session?.started_at ?? null);
  const title = session?.title?.trim() || 'ไลฟ์สด';

  const handleEnded = useCallback(() => setEndedWhileWatching(true), []);

  /**
   * Chat, reactions and the viewer count, on the session's Realtime channel.
   *
   * Opened here rather than inside the player because it is the same channel
   * whichever way the video arrives — that independence is the point of the
   * redesign, and it is why the two players are interchangeable.
   *
   * Called unconditionally, above everything that branches on `watch`: hooks
   * cannot be conditional, and a null sessionId keeps it idle until there is
   * something to join.
   */
  const watchable = watch.kind === 'hls' || watch.kind === 'livekit';
  const channel = useLiveChannel({
    sessionId: watchable ? sessionId : null,
    userId: user?.id ?? null,
    displayName: displayName || 'ผู้ชม',
    creatorUserId: watchable ? watch.creatorUserId : null,
  });

  /**
   * Gifting. The catalogue read is gated on the drawer being opened rather
   * than on the page state, so a viewer who never gifts never pays for it.
   */
  const [giftOpen, setGiftOpen] = useState(false);
  const [toast, setToast] = useState<FeedbackToastState | null>(null);
  const giftTiers = useGiftTiers(giftOpen || (preloadGiftTiers && channel.connected));
  const wallet = useWalletSummary();
  /**
   * The balance after the most recent send.
   *
   * `live-send-gift` returns it, and it is fresher than useWalletSummary's copy
   * — which was read when the page loaded and has no reason to know a star was
   * just spent. Refetching the whole summary per gift would be a round trip for
   * a number the send already answered with.
   */
  const [balanceAfterSend, setBalanceAfterSend] = useState<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast({ message, key: Date.now() });
  }, []);

  const handleSent = useCallback((walletBalance: number) => {
    setBalanceAfterSend(walletBalance);
    setToast({ message: 'ส่งของขวัญแล้ว 🎁', key: Date.now() });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);
  const openGift = useCallback(() => setGiftOpen(true), []);
  const closeGift = useCallback(() => setGiftOpen(false), []);

  const balance = balanceAfterSend ?? (wallet.loading ? null : wallet.balance);

  return {
    session,
    creator,
    watch,
    loading,
    refresh,
    title,
    elapsedSeconds,
    channel,
    endedWhileWatching,
    handleEnded,
    giftOpen,
    openGift,
    closeGift,
    giftTiers,
    balance,
    handleSent,
    toast,
    showToast,
    dismissToast,
  };
}
