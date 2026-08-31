'use client';

/**
 * The chat panel, shared by the broadcaster and the viewer screens.
 *
 * Messages travel on the LiveKit data channel, not Supabase Realtime: the room
 * is already open on both sides, `live_sessions` is not in the
 * `supabase_realtime` publication (only `stars_wallet` and `messages` are — see
 * lib/creator/constants.ts), and nothing writes chat to Postgres by design
 * (non-negotiable #6). So the panel is ephemeral in the strongest sense: a
 * viewer who joins late sees an empty panel, and everything is gone when the
 * room closes.
 *
 * LiveKit does not echo a participant's own data packets back to them, so a
 * sent message is appended locally. That local copy is the only record of it.
 *
 * The 👑 badge is derived from the LiveKit participant identity — which the
 * backend mints and the server asserts — never from the `sender` name inside
 * the payload, which is whatever the sender chose to call themselves.
 *
 * Emoji reactions share this data channel (see lib/live/reactions.ts). They
 * arrive at the same DataReceived handler and are dropped by decodeChat, which
 * accepts nothing but `type: 'chat'` — the panel is chat-only without needing
 * to know reactions exist.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import {
  RoomEvent,
  decodeChat,
  isCreatorIdentity,
  publishChat,
  type Room,
} from '@/lib/live/livekitClient';
import { MAX_CHAT_LENGTH, MAX_CHAT_MESSAGES } from '@/lib/live/constants';
import type { LiveChatEntry } from '@/lib/live/types';
import { ChatEmojiPicker } from './ChatEmojiPicker';

interface LiveChatProps {
  /** Null until the room is connected; the input stays disabled until then. */
  room: Room | null;
  /** What this participant's messages are signed with. */
  senderName: string;
  /** True on the broadcaster's screen, for their own optimistic echo's badge. */
  isCreator: boolean;
  className?: string;
}

export function LiveChat({ room, senderName, isCreator, className = '' }: LiveChatProps) {
  const [entries, setEntries] = useState<LiveChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Data packets carry no id and two can share a millisecond. */
  const seqRef = useRef(0);

  const append = useCallback((entry: Omit<LiveChatEntry, 'id'>) => {
    seqRef.current += 1;
    const withId: LiveChatEntry = { ...entry, id: `m${seqRef.current}` };
    // Oldest dropped rather than kept: this is the entire history there is,
    // and an unbounded array on a three-hour broadcast is a leak.
    setEntries((current) => [...current, withId].slice(-MAX_CHAT_MESSAGES));
  }, []);

  useEffect(() => {
    if (!room) return;

    const onData = (payload: Uint8Array, participant?: { identity: string }) => {
      const message = decodeChat(payload);
      if (!message) return;
      append({
        text: message.text,
        sender: message.sender,
        timestamp: message.timestamp,
        identity: participant?.identity ?? null,
        isCreator: isCreatorIdentity(participant?.identity),
        isSelf: false,
      });
    };

    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, append]);

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
    if (!room || text === '' || sending) return;

    setSending(true);
    try {
      await publishChat(room, text, senderName);
      append({
        text: text.slice(0, MAX_CHAT_LENGTH),
        sender: senderName,
        timestamp: Date.now(),
        identity: null,
        isCreator,
        isSelf: true,
      });
      setDraft('');
    } catch (err) {
      // No toast system in this repo (and the brief forbids adding one), so a
      // failed send leaves the text in the box — the message is not lost, and
      // pressing Enter again retries it.
      console.error('[LiveChat] publishData failed', err);
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
        {entries.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs leading-relaxed text-white/35">
            ยังไม่มีข้อความ
            <br />
            ทักทายกันได้เลย
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
          <ChatEmojiPicker onSelect={insertEmoji} disabled={!room} />

          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={MAX_CHAT_LENGTH}
            disabled={!room}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={room ? 'พิมพ์ข้อความ...' : 'กำลังเชื่อมต่อ...'}
            aria-label="ข้อความแชท"
            className="h-11 w-full min-w-0 rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white placeholder:text-white/25 focus:border-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!room || draft.trim() === '' || sending}
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
