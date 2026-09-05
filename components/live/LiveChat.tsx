'use client';

/**
 * The chat panel, shared by the broadcaster and the viewer screens.
 *
 * Messages travel on a Supabase Realtime broadcast channel, `live:<id>`. They
 * used to travel on the LiveKit data channel, which worked only because every
 * viewer was in the room — under LL-HLS a viewer is an HTTP request to a CDN,
 * so there is no room to reach them through. The channel is private, gated by
 * the same rule as the playback URL (see the realtime.messages policies in the
 * migration), so only people entitled to watch can read or write it.
 *
 * Still ephemeral in the strongest sense: nothing writes chat to Postgres, so
 * a viewer who joins late sees an empty panel and everything is gone when the
 * tab closes. That was a decision under LiveKit and it is still the decision.
 *
 * This component owns none of that. useLiveChannel holds the list, the
 * subscription and the local echo (the channel does not send a participant
 * their own messages back); the panel renders and submits.
 *
 * TWO PRESENTATIONS, ONE PANEL. `variant="overlay"` re-dresses the same list
 * and the same send path for the full-bleed phone watch layout — bubbles over
 * the video, no header, no card, and a tap that expands the column into
 * scrollable history. It is a prop rather than a second component on purpose:
 * a forked chat panel is two places to fix the next time a message shape
 * changes, and the 👑 rule below is exactly the kind of thing that would drift.
 *
 * THE 👑 IS A WEAKER CLAIM THAN IT WAS. LiveKit asserted participant identity
 * server-side, so the badge was a fact. A broadcast payload is written by its
 * sender, so the badge now means "the id this sender claimed matches the
 * creator id the backend told us". See lib/live/realtime.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Send } from 'lucide-react';
import { MAX_CHAT_LENGTH } from '@/lib/live/constants';
import { rarityStyle } from '@/lib/live/gifts';
import type { LiveChannelStatus } from '@/lib/live/realtime';
import type { LiveChatEntry } from '@/lib/live/types';
import { ChatEmojiPicker } from './ChatEmojiPicker';
import styles from './LiveChat.module.css';

/**
 * How the panel is dressed. The messages, the sending and the Realtime hook
 * behind them are the same in both.
 *
 * 'panel' — the original: a bordered card with a "แชทสด" header, a scrolling
 * list and an input row, sitting in a column beside (or under) the video.
 *
 * 'overlay' — the full-bleed phone layout: no card, no header, bubbles
 * floating over the video with the older ones fading out upward, and an input
 * row that runs the width of the screen under them. Tapping the column
 * expands it into scrollable history.
 *
 * A prop rather than a second component because a fork is two chat panels to
 * fix the next time a message shape changes; this way the list, the send path,
 * the emoji caret handling and the 👑 rule have exactly one implementation.
 */
export type LiveChatVariant = 'panel' | 'overlay';

interface LiveChatProps {
  /** The list, from useLiveChannel. This component never mutates it. */
  entries: LiveChatEntry[];
  /** useLiveChannel's send — it broadcasts and appends the local echo. */
  onSend: (text: string) => Promise<void>;
  /**
   * Where the channel is.
   *
   * Not a boolean, because "connecting" and "refused" need different copy.
   * A greyed-out box that says "กำลังเชื่อมต่อ..." forever is how a channel
   * the server rejected looks exactly like one that is about to work.
   */
  status: LiveChannelStatus;
  /**
   * Rendered in the input row, between the emoji picker and the text field.
   *
   * The gift button lives here rather than over the video because that is the
   * row a viewer's thumb is already in — and because a control floating on the
   * player would have to be `pointer-events: auto` inside an overlay that is
   * deliberately inert. The panel takes a slot rather than importing the drawer
   * so it stays usable on the creator's screen, which has no gift button.
   */
  action?: React.ReactNode;
  variant?: LiveChatVariant;
  /**
   * Overlay only: whether the column is showing full, scrollable history.
   *
   * CONTROLLED BY THE PAGE, not held here, because the page owns the other
   * half of the gesture: tapping the video collapses it again, and the video
   * is not this component's element. Ignored by the panel variant, which is
   * always "expanded" in the only sense it has.
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
  /**
   * Overlay only: extra classes for the MESSAGE LIST, not the panel.
   *
   * The two need different widths over a video. The list is a column up the
   * left — 70% of the screen at most, because the right edge belongs to the
   * reaction rail — while the composer under it runs the full width, since a
   * text field two thirds of a phone wide with three buttons after it is a
   * field nobody can read what they typed in.
   */
  listClassName?: string;
}

export function LiveChat({
  entries,
  onSend,
  status,
  action,
  variant = 'panel',
  expanded = false,
  onExpandedChange,
  className = '',
  listClassName = '',
}: LiveChatProps) {
  const overlay = variant === 'overlay';
  const enabled = status === 'connected';
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Follow the newest message. `block: 'nearest'` so the page itself does not
  // jump on the phone layout, where the panel is a sheet inside the viewport.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    // `expanded` is a dependency because growing the column from five lines to
    // 70vh changes the scroll height under a scrollTop that was already at the
    // bottom — without it, expanding lands the viewer part-way up the history.
  }, [entries, expanded]);

  /**
   * Put an emoji where the caret is, not at the end.
   *
   * The caret is read off the input rather than tracked in state: React does
   * not own the selection, and a controlled value that jumps to the end after
   * every insertion makes the picker useless for anything but the last
   * character. Restoring it has to wait for the re-render that carries the new
   * value, hence the rAF.
   */
  const insertEmoji = useCallback(
    (native: string) => {
      const input = inputRef.current;
      const start = input?.selectionStart ?? draft.length;
      const end = input?.selectionEnd ?? draft.length;
      const next = (draft.slice(0, start) + native + draft.slice(end)).slice(0, MAX_CHAT_LENGTH);
      if (next === draft) return;

      setDraft(next);
      const caret = Math.min(start + native.length, next.length);
      requestAnimationFrame(() => {
        const element = inputRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(caret, caret);
      });
    },
    [draft],
  );

  const send = async () => {
    const text = draft.trim();
    if (!enabled || text === '' || sending) return;

    setSending(true);
    try {
      await onSend(text);
      setDraft('');
    } catch (err) {
      // No toast system in this repo (and the brief forbids adding one), so a
      // failed send leaves the text in the box — the message is not lost, and
      // pressing Enter again retries it.
      console.error('[LiveChat] send failed', err);
    } finally {
      setSending(false);
    }
  };

  const setExpanded = (next: boolean) => onExpandedChange?.(next);

  return (
    <section
      aria-label="แชทสด"
      className={
        overlay
          ? // No card and no ground of its own: the bubbles are the only thing
            // painted, and everything between them is the broadcast.
            `flex min-h-0 flex-col justify-end ${className}`
          : `flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl ${className}`
      }
    >
      {/* The header is the panel's label. Over a video it would be a permanent
          box of chrome saying what the messages under it already say. */}
      {!overlay && (
        <h2 className="shrink-0 border-b border-white/8 px-4 py-3 text-sm font-semibold text-white/80">
          แชทสด
        </h2>
      )}

      {overlay && expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="pointer-events-auto mb-1.5 ml-3.5 inline-flex w-fit items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white/85 backdrop-blur-md focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <ChevronDown size={13} aria-hidden />
          ย่อ
        </button>
      )}

      <div
        ref={listRef}
        // aria-live is deliberately off: a live chat announced line by line
        // makes a screen reader unusable. The log role lets a user read it on
        // demand instead.
        role="log"
        // Collapsed, the column is a read-only strip over the video and the tap
        // that lands on it means "show me the rest" — the same gesture TikTok
        // uses. Expanded it scrolls, so the tap has to stop toggling or every
        // attempt to scroll would collapse it; the ย่อ chip above is the way
        // back. A keyboard user gets the button after the list.
        onClick={overlay && !expanded ? () => setExpanded(true) : undefined}
        className={
          overlay
            ? `${expanded ? `${styles.fadeExpanded} ${styles.listExpanded}` : `${styles.fade} ${styles.list}`} ${listClassName} pointer-events-auto min-h-0 space-y-1.5 ${
                expanded ? 'overflow-y-auto' : 'overflow-hidden'
              }`
            : 'min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3'
        }
      >
        {status === 'error' ? (
          <p
            role="alert"
            className={
              overlay
                ? 'w-fit rounded-xl bg-black/45 px-2.5 py-1.5 text-[11px] leading-snug text-rose-200/90 backdrop-blur-md'
                : 'px-1 py-6 text-center text-xs leading-relaxed text-rose-200/80'
            }
          >
            แชทใช้งานไม่ได้ในขณะนี้
            {overlay ? ' — รีเฟรชเพื่อลองใหม่' : <br />}
            {!overlay && 'กรุณารีเฟรชหน้านี้เพื่อลองใหม่'}
          </p>
        ) : entries.length === 0 ? (
          // Over the video the empty state is a whisper, not a card: there is a
          // broadcast behind it, and "ยังไม่มีข้อความ" in a centred box is the
          // sort of chrome the full-bleed layout exists to remove.
          <p
            className={
              overlay
                ? 'w-fit rounded-xl bg-black/38 px-2.5 py-1.5 text-[11px] leading-snug text-white/50 backdrop-blur-md'
                : 'px-1 py-6 text-center text-xs leading-relaxed text-white/35'
            }
          >
            {status === 'connected' ? (
              overlay ? (
                'ทักทายกันได้เลย'
              ) : (
                <>
                  ยังไม่มีข้อความ
                  <br />
                  ทักทายกันได้เลย
                </>
              )
            ) : (
              'กำลังเชื่อมต่อแชท...'
            )}
          </p>
        ) : (
          entries.map((entry) => <ChatBubble key={entry.id} entry={entry} variant={variant} />)
        )}
      </div>

      {/* The tap target above is a div, so this is what a keyboard or screen
          reader uses to reach the same state. Hidden once expanded, when the
          visible ย่อ chip is the control. */}
      {overlay && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="pointer-events-auto sr-only focus-visible:not-sr-only focus-visible:ml-3.5 focus-visible:mt-1 focus-visible:inline-flex focus-visible:w-fit focus-visible:rounded-full focus-visible:bg-black/55 focus-visible:px-2.5 focus-visible:py-1 focus-visible:text-[11px] focus-visible:text-white"
        >
          ขยายแชท
        </button>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className={
          overlay
            ? 'pointer-events-auto mt-2 shrink-0 px-3'
            : 'shrink-0 border-t border-white/8 p-3'
        }
      >
        <div className="flex items-end gap-2">
          {/* Order is reversed over the video: the field comes first, because
              the design puts the writing where the thumb rests and the three
              round buttons to its right. In the panel the picker leads, which
              is where it has always been on the creator's screen. */}
          {!overlay && <ChatEmojiPicker onSelect={insertEmoji} disabled={!enabled} />}
          {!overlay && action}

          <div className={overlay ? 'relative min-w-0 flex-1' : 'contents'}>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={MAX_CHAT_LENGTH}
              disabled={!enabled}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                enabled
                  ? overlay
                    ? '💬 พิมพ์ข้อความ...'
                    : 'พิมพ์ข้อความ...'
                  : status === 'error'
                    ? 'แชทใช้งานไม่ได้'
                    : 'กำลังเชื่อมต่อ...'
              }
              aria-label="ข้อความแชท"
              className={
                overlay
                  ? 'h-[42px] w-full min-w-0 rounded-full border border-white/10 bg-white/[0.14] pl-4 pr-11 text-sm text-white placeholder:text-white/55 backdrop-blur-md focus:border-purple-400/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50'
                  : 'h-11 w-full min-w-0 rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white placeholder:text-white/25 focus:border-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50'
              }
            />

            {/* Inside the pill over the video, and only once there is something
                to send. The design has no send button because a phone keyboard
                has a return key — but a viewer who pasted a message and
                dismissed the keyboard would otherwise have no way to post it. */}
            {overlay && draft.trim() !== '' && (
              <button
                type="submit"
                disabled={!enabled || sending}
                className="absolute right-1 top-1 inline-flex h-[34px] w-[34px] items-center justify-center rounded-full bg-gradient-to-r from-purple-500 to-cyan-400 text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-40"
              >
                <Send size={15} aria-hidden />
                <span className="sr-only">ส่งข้อความ</span>
              </button>
            )}
          </div>

          {overlay && <ChatEmojiPicker onSelect={insertEmoji} disabled={!enabled} />}
          {overlay && action}

          {!overlay && (
            <button
              type="submit"
              disabled={!enabled || draft.trim() === '' || sending}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-cyan-400 text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none"
            >
              <Send size={16} aria-hidden />
              <span className="sr-only">ส่งข้อความ</span>
            </button>
          )}
        </div>

        {/* The counter is a line of chrome under the row. Over the video it
            would be permanently on air for the 99% of the time the field is
            empty, so it appears only once the limit is in sight. */}
        {(!overlay || draft.length > MAX_CHAT_LENGTH - 40) && (
          <p
            className={`text-right text-[10px] tabular-nums text-white/25 ${
              overlay ? 'mt-1 pr-1' : 'mt-1.5'
            }`}
          >
            {draft.length}/{MAX_CHAT_LENGTH}
          </p>
        )}
      </form>
    </section>
  );
}

function ChatBubble({ entry, variant }: { entry: LiveChatEntry; variant: LiveChatVariant }) {
  const overlay = variant === 'overlay';

  /**
   * A gift line is a system line, not a message: nobody typed it, the text is
   * built from the broadcast event, and it carries the tier's rarity tint. It
   * lives in this list rather than in a feed of its own because it happened at
   * the same moment as the conversation around it — a separate panel would have
   * to be read separately to follow one thread.
   */
  if (entry.giftRarity) {
    const rarity = rarityStyle(entry.giftRarity);
    // The rarity tint is the same in both — it is what tells a viewer at a
    // glance how big the gift was, and it is the one thing about a gift line
    // the overlay must not water down.
    return (
      <p
        className={`border font-medium leading-snug ${rarity.surface} ${rarity.text} ${
          overlay
            ? 'w-fit max-w-full rounded-[14px] px-2.5 py-1.5 text-[12px] backdrop-blur-md'
            : 'rounded-xl px-3 py-2 text-[13px]'
        }`}
      >
        {entry.text}
      </p>
    );
  }

  /**
   * Over the video the name and the message share one line, and the bubble is
   * only as wide as its content.
   *
   * The panel's two-line shape works in a column of its own; in a 262px strip
   * over someone's face it is twice as much ink for the same words, and five of
   * them cover a third of the frame. Same data, same 👑 rule, laid out flat.
   */
  if (overlay) {
    return (
      <div
        className={`w-fit max-w-full rounded-[14px] px-2.5 py-1.5 text-[12px] leading-snug backdrop-blur-md ${
          entry.isCreator ? 'bg-purple-500/35 ring-1 ring-purple-300/30' : 'bg-black/[0.38]'
        }`}
      >
        <span className="font-semibold text-[#c4b5fd]">
          {entry.isCreator && (
            <span aria-label="ผู้ถ่ายทอด" title="ผู้ถ่ายทอด">
              👑{' '}
            </span>
          )}
          {entry.sender}
          {entry.isSelf && <span className="font-normal text-white/40"> (คุณ)</span>}
        </span>{' '}
        <span className="break-words text-white/95">{entry.text}</span>
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl px-3 py-2 ${
        entry.isCreator
          ? 'bg-gradient-to-r from-purple-500/25 to-cyan-500/15 ring-1 ring-purple-400/25'
          : 'bg-white/[0.05]'
      }`}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white/60">
        {entry.isCreator && (
          <span aria-label="ผู้ถ่ายทอด" title="ผู้ถ่ายทอด">
            👑
          </span>
        )}
        <span className="truncate">{entry.sender}</span>
        {entry.isSelf && <span className="shrink-0 text-white/30">(คุณ)</span>}
      </p>
      <p className="mt-0.5 break-words text-sm leading-snug text-white/90">{entry.text}</p>
    </div>
  );
}
