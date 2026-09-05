'use client';

/**
 * The creator's gift readout: the session totals, and who is paying for them.
 *
 * TWO SOURCES, AND THE SPLIT IS THE POINT
 *
 * The TOTALS come from `live_sessions` — a one-row read, re-run when a gift
 * event arrives. The LIST comes from the broadcast events this client has seen.
 *
 * They could both have come from the events, and that would have been wrong.
 * The channel's INSERT policy lets anyone entitled to watch put a message on
 * the topic (it is what makes chat work), so a modified client can forge
 * something shaped like a `gift`. Forging an ANIMATION is a nuisance; forging
 * the number a creator reads as their earnings is not. So the money is read
 * back from the table `send_live_gift` writes, and the events are used only as
 * the SIGNAL that it is worth re-reading — which is also why this needs no
 * polling: an idle broadcast makes no requests at all.
 *
 * The list is a leaderboard for the session in front of the creator, not an
 * accounting record, and it is honest about being what this client saw: a
 * creator who joined the channel late undercounts. That is the right trade for
 * a panel whose job is "say the name of whoever just sent the Nova".
 */

import { useEffect, useMemo, useState } from 'react';
import { Gift, Volume2, VolumeX } from 'lucide-react';
import { formatCount } from '@/lib/creator/format';
import type { LiveGiftEvent } from '@/lib/live/gifts';
import { getBrowserSupabase } from '@/lib/supabase-browser';

export interface GiftTotals {
  count: number;
  stars: number;
}

const ZERO: GiftTotals = { count: 0, stars: 0 };

/** How many names the panel shows. Five is what fits beside a video. */
const TOP_GIFTERS = 5;

/**
 * Session gift totals, re-read whenever a gift lands.
 *
 * `signal` is anything that changes per gift — the latest event's id will do.
 * Passing the totals themselves in the event and trusting them would be faster
 * and forgeable; this is one indexed single-row read instead.
 */
export function useSessionGiftTotals(
  sessionId: string | null,
  signal: string | null,
): GiftTotals {
  const [totals, setTotals] = useState<GiftTotals>(ZERO);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    async function read() {
      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        return;
      }

      const { data, error } = await supabase
        .from('live_sessions')
        .select('gift_count, gift_stars_total')
        .eq('id', sessionId)
        .maybeSingle();

      if (cancelled || error || !data) return;
      setTotals({
        count: Number(data.gift_count ?? 0),
        stars: Number(data.gift_stars_total ?? 0),
      });
    }

    void read();
    return () => {
      cancelled = true;
    };
    // `signal` is the whole point of the dependency list: a new gift id means
    // the row has changed, and nothing else does.
  }, [sessionId, signal]);

  return totals;
}

export interface CreatorGiftPanelProps {
  totals: GiftTotals;
  /** Newest first, from useLiveChannel. */
  gifts: LiveGiftEvent[];
  soundEnabled: boolean;
  onSoundToggle: () => void;
  className?: string;
}

export function CreatorGiftPanel({
  totals,
  gifts,
  soundEnabled,
  onSoundToggle,
  className = '',
}: CreatorGiftPanelProps) {
  /**
   * Top five by stars this session.
   *
   * Summed per sender rather than per gift: the person who sent twenty
   * Stardusts is one supporter, and a list that showed them twenty times would
   * be a log, not a leaderboard.
   */
  const top = useMemo(() => {
    const bySender = new Map<string, { name: string; stars: number; count: number }>();
    for (const gift of gifts) {
      const existing = bySender.get(gift.sender.id);
      if (existing) {
        existing.stars += gift.stars_total;
        existing.count += gift.quantity;
      } else {
        bySender.set(gift.sender.id, {
          name: gift.sender.display_name,
          stars: gift.stars_total,
          count: gift.quantity,
        });
      }
    }
    /**
     * Stars first, then COUNT.
     *
     * The count tiebreak is what keeps this list meaningful during free
     * preview: with every tier at 0, sorting on stars alone leaves the order
     * to whatever `Map` iteration happens to produce, so the "top" gifter
     * would be arbitrary. Ranking by how much someone sent is the honest
     * fallback when there is no money to rank by.
     */
    return [...bySender.values()]
      .sort((a, b) => b.stars - a.stars || b.count - a.count)
      .slice(0, TOP_GIFTERS);
  }, [gifts]);

  return (
    <section
      aria-label="ของขวัญในไลฟ์นี้"
      className={`shrink-0 rounded-2xl border border-white/10 bg-white/[0.03] p-3 backdrop-blur-xl ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5 tabular-nums text-white">
            <Gift size={15} className="text-amber-300" aria-hidden />
            <span className="font-bold">{formatCount(totals.count)}</span>
            <span className="sr-only">ของขวัญ</span>
          </span>
          {/* The star total is shown once there is one. During free preview a
              creator seeing "⭐ 0" beside a busy gift count would reasonably
              conclude the gifts were not being counted. */}
          {totals.stars > 0 ? (
            <span className="inline-flex items-center gap-1 font-bold tabular-nums text-amber-200">
              ⭐ {formatCount(totals.stars)}
            </span>
          ) : (
            totals.count > 0 && (
              <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-100">
                โหมดทดสอบ
              </span>
            )
          )}
        </div>

        <button
          type="button"
          onClick={onSoundToggle}
          aria-pressed={soundEnabled}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          {soundEnabled ? <Volume2 size={16} aria-hidden /> : <VolumeX size={16} aria-hidden />}
          <span className="sr-only">
            {soundEnabled ? 'ปิดเสียงของขวัญ' : 'เปิดเสียงของขวัญ'}
          </span>
        </button>
      </div>

      {top.length > 0 && (
        <ol className="mt-3 space-y-1 border-t border-white/8 pt-2.5">
          {top.map((entry, index) => (
            <li key={entry.name + index} className="flex items-center gap-2 text-[11px]">
              <span className="w-4 shrink-0 text-center font-bold tabular-nums text-white/30">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-white/75">{entry.name}</span>
              <span className="shrink-0 font-semibold tabular-nums text-amber-200">
                {entry.stars > 0 ? `${formatCount(entry.stars)} ⭐` : `×${formatCount(entry.count)}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
