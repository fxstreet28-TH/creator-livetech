'use client';

/**
 * /dev/gifts — a bench for the gift overlay, with no live session in the way.
 *
 * Testing an overlay through the real path means two browsers, a creator on
 * air, a funded wallet and a star spent per attempt. That is the right test for
 * the money, and the wrong loop for tuning a keyframe: this page enqueues
 * fabricated events straight into the same GiftOverlay every live screen
 * mounts, so an animation can be watched forty times in a minute for free.
 *
 * NOT REACHABLE IN PRODUCTION. `notFound()` in a production build means the
 * route renders a 404 rather than merely being unlinked — the overlay is the
 * only thing here, but a page that can fake gift events should not answer to
 * anyone who guesses the URL. Kept rather than deleted because the next person
 * to touch an animation needs it as much as this one did.
 *
 * The buttons feed the queue, not the database. Nothing here spends a star,
 * writes a row, or reaches the network.
 */

import { useCallback, useMemo, useState } from 'react';
import { notFound } from 'next/navigation';
import { GiftOverlay } from '@/components/live/gifts/GiftOverlay';
import {
  fetchGiftTiers,
  rarityStyle,
  type GiftTier,
  type LiveGiftEvent,
} from '@/lib/live/gifts';
import { getBrowserSupabase } from '@/lib/supabase-browser';

/**
 * The catalogue, hardcoded, for when there is no session to read one.
 *
 * The ONLY hardcoded prices in the codebase, and they are fake on purpose —
 * this page never sends anything, so these numbers cannot become a charge. The
 * "โหลดจากฐานข้อมูล" button replaces them with the real rows for anyone signed
 * in, which is also how you check that a tier the CEO just added renders.
 */
const FALLBACK_TIERS: GiftTier[] = [
  { id: 1, slug: 'stardust', name_en: 'Stardust', name_th: 'ผงดาว', subtitle_th: null, rarity: 'basic', price_stars: 1, animation_key: 'stardust', duration_ms: 4500, display_mode: 'tray', max_quantity: 99, sort_order: 1 },
  { id: 2, slug: 'moonlight', name_en: 'Moonlight', name_th: 'แสงจันทร์', subtitle_th: null, rarity: 'rare', price_stars: 5, animation_key: 'moonlight', duration_ms: 5500, display_mode: 'tray', max_quantity: 99, sort_order: 2 },
  { id: 3, slug: 'comet', name_en: 'Comet', name_th: 'ดาวหาง', subtitle_th: null, rarity: 'epic', price_stars: 20, animation_key: 'comet', duration_ms: 6500, display_mode: 'fullscreen', max_quantity: 99, sort_order: 3 },
  { id: 4, slug: 'nova', name_en: 'Nova', name_th: 'โนวา', subtitle_th: null, rarity: 'legendary', price_stars: 100, animation_key: 'nova', duration_ms: 10000, display_mode: 'fullscreen', max_quantity: 99, sort_order: 4 },
  { id: 5, slug: 'tier-05', name_en: 'TBD', name_th: 'TBD', subtitle_th: null, rarity: 'legendary', price_stars: 300, animation_key: 'generic', duration_ms: 3500, display_mode: 'fullscreen', max_quantity: 99, sort_order: 5 },
  { id: 6, slug: 'tier-06', name_en: 'TBD', name_th: 'TBD', subtitle_th: null, rarity: 'mythic', price_stars: 1000, animation_key: 'generic', duration_ms: 3500, display_mode: 'fullscreen', max_quantity: 99, sort_order: 6 },
  { id: 7, slug: 'tier-07', name_en: 'TBD', name_th: 'TBD', subtitle_th: null, rarity: 'mythic', price_stars: 3000, animation_key: 'generic', duration_ms: 3500, display_mode: 'fullscreen', max_quantity: 99, sort_order: 7 },
];

const SENDERS = [
  { id: 'dev-a', display_name: 'ผู้ชมทดสอบ A' },
  { id: 'dev-b', display_name: 'ผู้ชมทดสอบ B' },
  { id: 'dev-c', display_name: 'somchai_2540' },
];

export default function DevGiftsPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <GiftBench />;
}

function GiftBench() {
  const [tiers, setTiers] = useState<GiftTier[]>(FALLBACK_TIERS);
  const [tierSource, setTierSource] = useState<'fallback' | 'database'>('fallback');
  const [senderIndex, setSenderIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState('');
  const [latestGift, setLatestGift] = useState<LiveGiftEvent | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const sender = SENDERS[senderIndex];

  const fire = useCallback(
    (tier: GiftTier, overrides?: Partial<LiveGiftEvent>) => {
      const event: LiveGiftEvent = {
        // Unique per press, so the queue's de-duplication does not swallow the
        // second click on the same button. The replay button below reuses an
        // id on purpose, to prove de-duplication works.
        gift_id: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        session_id: 'dev-session',
        tier_id: tier.id,
        tier_slug: tier.slug,
        name_en: tier.name_en,
        name_th: tier.name_th,
        rarity: tier.rarity,
        animation_key: tier.animation_key,
        display_mode: tier.display_mode,
        duration_ms: tier.duration_ms,
        quantity,
        stars_total: tier.price_stars * quantity,
        message: message.trim() === '' ? null : message.trim(),
        sender: { ...sender, avatar_url: null },
        created_at: new Date().toISOString(),
        ...overrides,
      };
      setLatestGift(event);
      setLog((current) =>
        [`${new Date().toLocaleTimeString('th-TH')} · ${event.name_en} ×${event.quantity} · ${event.sender.display_name} · ${event.gift_id.slice(0, 14)}`, ...current].slice(0, 12),
      );
      return event;
    },
    [quantity, message, sender],
  );

  /** Gate 6: the same id twice must produce ONE animation. */
  const replayLast = useCallback(() => {
    if (!latestGift) return;
    setLatestGift({ ...latestGift, created_at: new Date().toISOString() });
    setLog((current) => [`↻ replayed ${latestGift.gift_id.slice(0, 14)} (expect no second row)`, ...current].slice(0, 12));
  }, [latestGift]);

  /** Gate 5: a Nova and a Comet inside the batch window — Nova must play first. */
  const novaThenComet = useCallback(() => {
    const nova = tiers.find((tier) => tier.animation_key === 'nova');
    const comet = tiers.find((tier) => tier.animation_key === 'comet');
    if (!comet || !nova) return;
    fire(comet);
    // A real pair arrives milliseconds apart over the same socket; the timeout
    // is what makes them two separate enqueues rather than one render.
    setTimeout(() => fire(nova), 120);
  }, [tiers, fire]);

  /** Gate 4: three of the same gift in a row must be ONE tray row with ×3. */
  const comboBurst = useCallback(() => {
    const stardust = tiers.find((tier) => tier.animation_key === 'stardust') ?? tiers[0];
    fire(stardust);
    setTimeout(() => fire(stardust), 250);
    setTimeout(() => fire(stardust), 500);
  }, [tiers, fire]);

  /** The pending cap and the shed order: 40 gifts as fast as React will take them. */
  const flood = useCallback(() => {
    tiers.forEach((tier, index) => {
      for (let i = 0; i < 6; i += 1) {
        setTimeout(() => fire(tier), index * 40 + i * 12);
      }
    });
  }, [tiers, fire]);

  const loadFromDatabase = useCallback(async () => {
    try {
      const supabase = getBrowserSupabase();
      const { tiers: rows, error } = await fetchGiftTiers(supabase);
      if (error || rows.length === 0) {
        setLog((current) => [`⚠ ${error ?? 'no active tiers'}`, ...current].slice(0, 12));
        return;
      }
      setTiers(rows);
      setTierSource('database');
      setLog((current) => [`✓ loaded ${rows.length} tiers from gift_tiers`, ...current].slice(0, 12));
    } catch {
      setLog((current) => ['⚠ Supabase is not configured in this environment', ...current].slice(0, 12));
    }
  }, []);

  const quantities = useMemo(() => [1, 3, 10, 99], []);

  return (
    <main className="min-h-dvh bg-[#0a0a15] p-4 text-white">
      <h1 className="text-lg font-bold">Gift overlay bench</h1>
      <p className="mt-1 text-xs text-white/45">
        เฉพาะ development — ไม่มีการหักดาวหรือเขียนฐานข้อมูล. Tiers:{' '}
        <span className="font-semibold text-cyan-300">{tierSource}</span>
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* The stand-in for a video player: same relative box the overlay is
            mounted into on both live screens, so the tray anchors and the
            fullscreen sizing behave exactly as they will in production. */}
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#1a1030] via-[#0e1030] to-[#04121e]">
          <p className="absolute inset-0 grid place-items-center text-sm text-white/20">
            (ตำแหน่งวิดีโอ)
          </p>
          <GiftOverlay latestGift={latestGift} />
        </div>

        <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-white/40">Tier</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {tiers.map((tier) => {
                const rarity = rarityStyle(tier.rarity);
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => fire(tier)}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-left text-xs transition hover:brightness-125 ${rarity.surface}`}
                  >
                    <span className={`block font-bold ${rarity.text}`}>{tier.name_en}</span>
                    <span className="block text-white/50">
                      ⭐{tier.price_stars} · {tier.display_mode} · {tier.duration_ms}ms
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-white/40">Sender</p>
            <div className="mt-2 flex gap-2">
              {SENDERS.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setSenderIndex(index)}
                  className={`min-h-11 flex-1 rounded-xl border px-2 text-xs transition ${
                    index === senderIndex
                      ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-100'
                      : 'border-white/10 bg-white/[0.03] text-white/60'
                  }`}
                >
                  {option.id.replace('dev-', '').toUpperCase()}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-white/35">
              เปลี่ยน sender เพื่อทดสอบว่า combo รวมเฉพาะคนเดียวกัน + tier เดียวกัน
            </p>
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-white/40">Quantity</p>
            <div className="mt-2 flex gap-2">
              {quantities.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setQuantity(value)}
                  className={`min-h-11 flex-1 rounded-xl border text-xs transition ${
                    value === quantity
                      ? 'border-purple-400/60 bg-purple-500/15 text-purple-100'
                      : 'border-white/10 bg-white/[0.03] text-white/60'
                  }`}
                >
                  ×{value}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
              Message
            </span>
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value.slice(0, 80))}
              placeholder="(ไม่บังคับ)"
              className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-white placeholder:text-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            />
          </label>

          <div className="grid grid-cols-2 gap-2 border-t border-white/8 pt-3">
            <Bench label="Combo ×3" onClick={comboBurst} />
            <Bench label="Nova + Comet" onClick={novaThenComet} />
            <Bench label="Replay last id" onClick={replayLast} />
            <Bench label="Flood 42" onClick={flood} />
            <Bench label="โหลดจากฐานข้อมูล" onClick={() => void loadFromDatabase()} wide />
          </div>

          <ol className="max-h-40 space-y-1 overflow-y-auto border-t border-white/8 pt-3 text-[11px] text-white/40">
            {log.map((line, index) => (
              <li key={index} className="truncate">
                {line}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </main>
  );
}

function Bench({
  label,
  onClick,
  wide = false,
}: {
  label: string;
  onClick: () => void;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-11 rounded-xl border border-white/12 bg-white/[0.04] px-3 text-xs font-medium text-white/75 transition hover:bg-white/[0.08] ${
        wide ? 'col-span-2' : ''
      }`}
    >
      {label}
    </button>
  );
}
