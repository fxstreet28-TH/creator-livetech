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
 * THE 👑 IS A WEAKER CLAIM THAN IT WAS. LiveKit asserted participant identity
 * server-side, so the badge was a fact. A broadcast payload is written by its
 * sender, so the badge now means "the id this sender claimed matches the
 * creator id the backend told us". See lib/live/realtime.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { MAX_CHAT_LENGTH } from '@/lib/live/constants';
import { rarityStyle } from '@/lib/live/gifts';
import type { LiveChannelStatus } from '@/lib/live/realtime';
import type { LiveChatEntry } from '@/lib/live/types';
import { ChatEmojiPicker } from './ChatEmojiPicker';

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
  className?: string;
}

export function LiveChat({ entries, onSend, status, action, className = '' }: LiveChatProps) {
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
  }, [entries]);

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

  return (
    <section
      aria-label="แชทสด"
      className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl ${className}`}
    >
      <h2 className="shrink-0 border-b border-white/8 px-4 py-3 text-sm font-semibold text-white/80">
        แชทสด
      </h2>

      <div
        ref={listRef}
        // aria-live is deliberately off: a live chat announced line by line
        // makes a screen reader unusable. The log role lets a user read it on
        // demand instead.
        role="log"
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3"
      >
        {status === 'error' ? (
          <p role="alert" className="px-1 py-6 text-center text-xs leading-relaxed text-rose-200/80">
            แชทใช้งานไม่ได้ในขณะนี้
            <br />
            กรุณารีเฟรชหน้านี้เพื่อลองใหม่
          </p>
        ) : entries.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs leading-relaxed text-white/35">
            {status === 'connected' ? (
              <>
                ยังไม่มีข้อความ
                <br />
                ทักทายกันได้เลย
              </>
            ) : (
              'กำลังเชื่อมต่อแชท...'
            )}
          </p>
        ) : (
          entries.map((entry) => <ChatBubble key={entry.id} entry={entry} />)
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="shrink-0 border-t border-white/8 p-3"
      >
        <div className="flex items-end gap-2">
          <ChatEmojiPicker onSelect={insertEmoji} disabled={!enabled} />
          {action}

          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={MAX_CHAT_LENGTH}
            disabled={!enabled}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              enabled
                ? 'พิมพ์ข้อความ...'
                : status === 'error'
                  ? 'แชทใช้งานไม่ได้'
                  : 'กำลังเชื่อมต่อ...'
            }
            aria-label="ข้อความแชท"
            className="h-11 w-full min-w-0 rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white placeholder:text-white/25 focus:border-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!enabled || draft.trim() === '' || sending}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-cyan-400 text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none"
          >
            <Send size={16} aria-hidden />
            <span className="sr-only">ส่งข้อความ</span>
          </button>
        </div>
        <p className="mt-1.5 text-right text-[10px] tabular-nums text-white/25">
          {draft.length}/{MAX_CHAT_LENGTH}
        </p>
      </form>
    </section>
  );
}

function ChatBubble({ entry }: { entry: LiveChatEntry }) {
  /**
   * A gift line is a system line, not a message: nobody typed it, the text is
   * built from the broadcast event, and it carries the tier's rarity tint. It
   * lives in this list rather than in a feed of its own because it happened at
   * the same moment as the conversation around it — a separate panel would have
   * to be read separately to follow one thread.
   */
  if (entry.giftRarity) {
    const rarity = rarityStyle(entry.giftRarity);
    return (
      <p
        className={`rounded-xl border px-3 py-2 text-[13px] font-medium leading-snug ${rarity.surface} ${rarity.text}`}
      >
        {entry.text}
      </p>
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
