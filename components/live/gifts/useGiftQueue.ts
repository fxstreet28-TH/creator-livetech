'use client';

/**
 * The gift overlay's scheduler: what is on screen, what is waiting, and when
 * each one leaves.
 *
 * All of the decisions live in the two pure functions at the top —
 * `enqueueEvent` and `advance` — and the hook at the bottom is only a clock
 * driving them. That split is deliberate: everything interesting here is
 * timing and ordering, which is exactly the kind of logic that is impossible to
 * reason about once it is spread across a dozen setTimeouts inside a component,
 * and trivial to check when it is `(state, event, now) => state`.
 *
 * ONE TICKER, NOT ONE TIMER PER ITEM
 *
 * A busy broadcast can land thirty gifts in a few seconds. A timeout each
 * would be thirty timers to cancel correctly on unmount, on a combo bump, and
 * on a session change — and a leaked one fires a state update into an unmounted
 * tree. The model is instead a function of `now`, and one interval advances it
 * while anything is on screen. Nothing is scheduled; things simply become
 * expired.
 *
 * THE FOUR RULES THE SHAPE COMES FROM
 *
 *  1. De-duplicate. Realtime replays on reconnect, so the same gift can arrive
 *     twice with the same id. Without this, a viewer whose train goes through a
 *     tunnel watches the last minute of gifts play again.
 *
 *  2. Combine. Tapping a 1-star gift ten times is one gesture, not ten events
 *     — it collapses into one row with a ×10 rather than shoving nine other
 *     people's gifts off the screen.
 *
 *  3. Three tray rows. More than that and the rows are what the viewer is
 *     watching instead of the video.
 *
 *  4. One fullscreen gift at a time, big ones first — but only against what
 *     arrived within two seconds of the one at the head of the queue, so a
 *     stream of Novas can never starve a Comet that is already waiting.
 */

import { useCallback, useEffect, useMemo, useReducer } from 'react';
import type { LiveGiftEvent } from '@/lib/live/gifts';

/** How many recent gift ids are remembered for de-duplication. */
const SEEN_LIMIT = 200;

/** Tray rows visible at once. */
export const MAX_TRAY_ROWS = 3;

/**
 * The floor on how long a tray row stays up.
 *
 * A tier could be configured with a 1-second duration; a row that appears and
 * leaves inside a second is a flicker, not a thank-you.
 */
const MIN_TRAY_MS = 3_000;

/**
 * How far back the fullscreen queue looks when choosing what plays next.
 *
 * A Nova and a Comet sent in the same second should play biggest-first — the
 * viewer perceives them as one moment. Two gifts a minute apart are two
 * moments and must stay in the order they happened, or a busy stream of
 * expensive gifts would leave a cheaper one waiting forever.
 */
const FULLSCREEN_BATCH_MS = 2_000;

/** Pending items held before the cheapest are dropped. */
const MAX_PENDING = 30;

/** How often the model is advanced while anything is on screen or waiting. */
const TICK_MS = 200;

export interface TrayItem {
  /**
   * Stable for the life of the row, INCLUDING across combo bumps — React keys
   * off this, and a key that changed on every ×N would unmount and remount the
   * row, restarting its animation and losing its slide-out.
   */
  key: string;
  /** The most recent event in this combo: the name, rarity and message shown. */
  event: LiveGiftEvent;
  /** Units, summed across the combo. */
  count: number;
  /** Stars, summed across the combo. */
  starsTotal: number;
  /** When the row slides out, unless another combo bump pushes it back. */
  expiresAt: number;
  /**
   * Increments on every bump. The ×N badge keys its pop animation off this, so
   * the tenth tap pops as visibly as the second.
   */
  bumpSeq: number;
}

export interface FullscreenItem {
  key: string;
  event: LiveGiftEvent;
  /** When it ends. Fixed at promotion; a fullscreen gift never combos. */
  endsAt: number;
}

interface PendingFullscreen {
  key: string;
  event: LiveGiftEvent;
  /** Arrival, for the batch window. Not the event's own created_at, which is
   *  the sender's side of a network hop and can be out of order. */
  receivedAt: number;
}

export interface GiftQueueState {
  /** Ring of recently seen gift ids, newest last. */
  seen: string[];
  /** Visible rows, NEWEST FIRST. */
  tray: TrayItem[];
  trayPending: LiveGiftEvent[];
  fullscreen: FullscreenItem | null;
  fullscreenPending: PendingFullscreen[];
  /** Monotonic, so two gifts in the same millisecond get different keys. */
  seq: number;
}

export const EMPTY_QUEUE: GiftQueueState = {
  seen: [],
  tray: [],
  trayPending: [],
  fullscreen: null,
  fullscreenPending: [],
  seq: 0,
};

function trayLifetime(event: LiveGiftEvent): number {
  return Math.max(MIN_TRAY_MS, event.duration_ms);
}

/**
 * Which of two pending fullscreen gifts plays first: the more valuable, and on
 * a tie the higher-ranked tier.
 *
 * THE TIEBREAK IS NOT DECORATION. Under free preview every tier costs 0, so
 * `stars_total` ties on EVERY comparison and a stars-only rule silently
 * degrades to plain FIFO — a Nova sent a moment after a Comet would wait behind
 * it, which is the one ordering rule this queue has. `sort_order` comes from
 * `gift_tiers` on the broadcast payload and still ranks the catalogue when the
 * prices do not.
 *
 * DESCENDING sort_order, deliberately, and this is where the brief contradicts
 * itself: it specifies `price_stars desc, sort_order asc`, but sort_order
 * ASCENDING would put Stardust (1) ahead of Nova (4) once prices tie — the
 * exact reverse of the "Nova plays first" behaviour the same brief lists as a
 * QA gate. The gate expresses the intent (the bigger gift goes first), so the
 * tiebreak follows the intent and ranks downward. Flagged in the PR.
 */
function outranks(candidate: PendingFullscreen, incumbent: PendingFullscreen): boolean {
  if (candidate.event.stars_total !== incumbent.event.stars_total) {
    return candidate.event.stars_total > incumbent.event.stars_total;
  }
  if (candidate.event.sort_order !== incumbent.event.sort_order) {
    return candidate.event.sort_order > incumbent.event.sort_order;
  }
  // Same tier, same price: whichever arrived first. `reduce` keeps the
  // incumbent on a false, and the incumbent is always the earlier item.
  return false;
}

/** Which visible row a new gift combines into, if any. */
function comboIndex(tray: TrayItem[], event: LiveGiftEvent): number {
  return tray.findIndex(
    (item) => item.event.sender.id === event.sender.id && item.event.tier_id === event.tier_id,
  );
}

/**
 * Shed pending items once the queue is past its cap.
 *
 * Cheapest tray items go first, and that ordering is the point rather than an
 * implementation detail: when a flood is dropping gifts, the ones that must
 * survive are the ones somebody paid the most for. Fullscreen pending is only
 * touched once there are no tray items left to drop, because a fullscreen gift
 * is by definition one of the expensive tiers.
 */
function shedOverflow(state: GiftQueueState): GiftQueueState {
  let trayPending = state.trayPending;
  let fullscreenPending = state.fullscreenPending;

  const total = () => trayPending.length + fullscreenPending.length;
  if (total() <= MAX_PENDING) return state;

  const cheapestIndex = <T,>(items: T[], stars: (item: T) => number): number => {
    let best = 0;
    for (let i = 1; i < items.length; i += 1) {
      // Strictly less-than, so a tie keeps the OLDEST — dropping the newer of
      // two equal gifts is the one that has waited least.
      if (stars(items[i]) < stars(items[best])) best = i;
    }
    return best;
  };

  while (total() > MAX_PENDING) {
    if (trayPending.length > 0) {
      const index = cheapestIndex(trayPending, (event) => event.stars_total);
      trayPending = trayPending.filter((_, i) => i !== index);
    } else {
      const index = cheapestIndex(fullscreenPending, (item) => item.event.stars_total);
      fullscreenPending = fullscreenPending.filter((_, i) => i !== index);
    }
  }

  return { ...state, trayPending, fullscreenPending };
}

/**
 * Take one gift into the model.
 *
 * Pure, and `now` is a parameter rather than a `Date.now()` call inside, so a
 * test can drive an hour of gifts through it in a millisecond.
 */
export function enqueueEvent(
  state: GiftQueueState,
  event: LiveGiftEvent,
  now: number,
): GiftQueueState {
  // 1. Already seen — a Realtime replay after a reconnect.
  if (state.seen.includes(event.gift_id)) return state;
  const seen = [...state.seen, event.gift_id].slice(-SEEN_LIMIT);

  const seq = state.seq + 1;
  const key = `g${seq}`;

  if (event.display_mode === 'fullscreen') {
    return shedOverflow({
      ...state,
      seen,
      seq,
      fullscreenPending: [...state.fullscreenPending, { key, event, receivedAt: now }],
    });
  }

  // 2. Combo into a row that is still on screen.
  const index = comboIndex(state.tray, event);
  if (index !== -1) {
    const existing = state.tray[index];
    const bumped: TrayItem = {
      ...existing,
      // The newest event wins for the message, so a second gift with a note
      // replaces a first without one rather than the note never being seen.
      event,
      count: existing.count + event.quantity,
      starsTotal: existing.starsTotal + event.stars_total,
      expiresAt: now + trayLifetime(event),
      bumpSeq: existing.bumpSeq + 1,
    };
    const tray = [...state.tray];
    tray[index] = bumped;
    return { ...state, seen, seq, tray };
  }

  // 3. Room on screen — show it now, newest on top.
  if (state.tray.length < MAX_TRAY_ROWS) {
    const item: TrayItem = {
      key,
      event,
      count: event.quantity,
      starsTotal: event.stars_total,
      expiresAt: now + trayLifetime(event),
      bumpSeq: 0,
    };
    return { ...state, seen, seq, tray: [item, ...state.tray] };
  }

  // 4. Otherwise it waits, in arrival order.
  return shedOverflow({ ...state, seen, seq, trayPending: [...state.trayPending, event] });
}

/**
 * Move the model to `now`: retire what has finished, promote what is waiting.
 *
 * Returns the SAME object when nothing changed, so the reducer can skip the
 * re-render — this runs five times a second for the length of a broadcast.
 *
 * `promoteFullscreen` is what makes the batch window mean anything, and it is
 * subtler than it looks. Promotion has to happen on the TICK and not inside the
 * enqueue that delivered a gift: a Comet arriving to an empty queue would
 * otherwise start playing in the same instant it landed, and the Nova sent a
 * tenth of a second behind it would find the stage taken and queue up second —
 * the exact case the window exists to fix. Deferring by one tick costs a lone
 * gift up to 200ms nobody can perceive, and buys the "sent in the same moment"
 * comparison that a viewer very much can.
 *
 * The tray does NOT defer: a tray row has no stage to contend for, so there is
 * nothing to gain by making it wait and a visible lag to lose.
 */
export function advance(
  state: GiftQueueState,
  now: number,
  promoteFullscreen = true,
): GiftQueueState {
  let changed = false;

  // --- tray ---------------------------------------------------------------
  let tray = state.tray.filter((item) => item.expiresAt > now);
  if (tray.length !== state.tray.length) changed = true;

  let trayPending = state.trayPending;
  let seq = state.seq;

  while (tray.length < MAX_TRAY_ROWS && trayPending.length > 0) {
    const [next, ...rest] = trayPending;
    trayPending = rest;

    // A queued gift can still combine — the row it belongs with may have been
    // on screen the whole time it was waiting behind a full tray.
    const index = comboIndex(tray, next);
    if (index !== -1) {
      const existing = tray[index];
      tray = tray.map((item, i) =>
        i === index
          ? {
              ...existing,
              event: next,
              count: existing.count + next.quantity,
              starsTotal: existing.starsTotal + next.stars_total,
              expiresAt: now + trayLifetime(next),
              bumpSeq: existing.bumpSeq + 1,
            }
          : item,
      );
    } else {
      seq += 1;
      tray = [
        {
          key: `g${seq}`,
          event: next,
          count: next.quantity,
          starsTotal: next.stars_total,
          expiresAt: now + trayLifetime(next),
          bumpSeq: 0,
        },
        ...tray,
      ];
    }
    changed = true;
  }

  // --- fullscreen ---------------------------------------------------------
  let fullscreen = state.fullscreen;
  let fullscreenPending = state.fullscreenPending;

  if (fullscreen && fullscreen.endsAt <= now) {
    fullscreen = null;
    changed = true;
  }

  if (promoteFullscreen && !fullscreen && fullscreenPending.length > 0) {
    // The head of the queue defines the window; the most valuable gift that
    // arrived inside it plays. Nothing outside the window may jump, which is
    // what bounds how long the head can be made to wait.
    const oldest = fullscreenPending.reduce(
      (best, item) => (item.receivedAt < best.receivedAt ? item : best),
      fullscreenPending[0],
    );
    const windowEnd = oldest.receivedAt + FULLSCREEN_BATCH_MS;
    const batch = fullscreenPending.filter((item) => item.receivedAt <= windowEnd);
    const chosen = batch.reduce((best, item) => (outranks(item, best) ? item : best), batch[0]);

    fullscreen = { key: chosen.key, event: chosen.event, endsAt: now + chosen.event.duration_ms };
    fullscreenPending = fullscreenPending.filter((item) => item.key !== chosen.key);
    changed = true;
  }

  if (!changed) return state;
  return { ...state, tray, trayPending, fullscreen, fullscreenPending, seq };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

type QueueAction =
  | { type: 'enqueue'; event: LiveGiftEvent; now: number }
  | { type: 'tick'; now: number }
  | { type: 'clear' };

function reducer(state: GiftQueueState, action: QueueAction): GiftQueueState {
  switch (action.type) {
    case 'enqueue':
      // Advanced first so a gift arriving after a lull is judged against a tray
      // that has already been emptied by time, not against three rows that
      // expired while nothing was ticking. Fullscreen promotion is held back to
      // the next tick — see the note on `advance`.
      return enqueueEvent(advance(state, action.now, false), action.event, action.now);
    case 'tick':
      return advance(state, action.now);
    case 'clear':
      // `seen` is deliberately kept. Clearing happens when the overlay is torn
      // down and rebuilt (a reconnect, a re-mount) — which is precisely when a
      // replay is most likely, and forgetting the ids would let the whole
      // backlog play again.
      return { ...EMPTY_QUEUE, seen: state.seen, seq: state.seq };
    default:
      return state;
  }
}

export interface UseGiftQueueResult {
  trayItems: TrayItem[];
  fullscreenItem: FullscreenItem | null;
  enqueue: (event: LiveGiftEvent) => void;
  clear: () => void;
}

export function useGiftQueue(): UseGiftQueueResult {
  const [state, dispatch] = useReducer(reducer, EMPTY_QUEUE);

  const enqueue = useCallback((event: LiveGiftEvent) => {
    dispatch({ type: 'enqueue', event, now: Date.now() });
  }, []);

  const clear = useCallback(() => dispatch({ type: 'clear' }), []);

  /**
   * Whether anything still needs the clock.
   *
   * Read as a boolean rather than as the state itself so the effect below is
   * not torn down and rebuilt on every tick — an idle broadcast has no
   * interval running at all, which matters on a page that may be open for
   * three hours.
   */
  const busy =
    state.tray.length > 0 ||
    state.trayPending.length > 0 ||
    state.fullscreen !== null ||
    state.fullscreenPending.length > 0;

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), TICK_MS);
    return () => clearInterval(timer);
  }, [busy]);

  return useMemo(
    () => ({
      trayItems: state.tray,
      fullscreenItem: state.fullscreen,
      enqueue,
      clear,
    }),
    [state.tray, state.fullscreen, enqueue, clear],
  );
}
