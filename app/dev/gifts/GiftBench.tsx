'use client';

/**
 * The bench itself. Gated by the server component beside it — see its header
 * for why the environment check cannot live in this file.
 *
 * The tier buttons feed the queue directly: no star is spent, no row is
 * written, nothing is sent. Two controls do reach the network, and both are
 * labelled: "โหลดจากฐานข้อมูล" reads the real catalogue so a tier the CEO just
 * repriced can be checked, and the drawer preview will genuinely call
 * `live-send-gift` if its send button is pressed — against the bench's fake
 * session id, which the server refuses with SESSION_NOT_LIVE. That refusal is
 * the point: it exercises the real error mapping rather than a mock of it.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  allTiersFree,
  fetchGiftTiers,
  isFreeTier,
  rarityStyle,
  type GiftTier,
  type LiveGiftEvent,
} from '@/lib/live/gifts';
import { GiftDrawer } from '@/components/live/gifts/GiftDrawer';
import { GiftOverlay } from '@/components/live/gifts/GiftOverlay';
import { getBrowserSupabase } from '@/lib/supabase-browser';

/**
 * The catalogue, hardcoded, for when there is no database to read one from.
 *
 * The ONLY hardcoded prices in the codebase, and they are fake on purpose —
 * this page never sends anything, so these numbers cannot become a charge. They
 * are the PRE-free-preview prices rather than zeroes, so the bench exercises
 * the paid rendering path (star counts, the most-valuable-first ordering) that
 * the live database currently cannot. "โหลดจากฐานข้อมูล" swaps in the real rows,
 * which is how the free-mode rendering gets checked.
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

/** Gap between tiers in "เล่นครบ 7 ชั้น". */
const SEQUENCE_GAP_MS = 600;

export function GiftBench() {
  const [loadedTiers, setLoadedTiers] = useState<GiftTier[]>(FALLBACK_TIERS);
  const [tierSource, setTierSource] = useState<'fallback' | 'database'>('fallback');
  /**
   * Render every tier as if it were priced at 0.
   *
   * FREE PREVIEW is a property of the DATA, so the only honest way to see it is
   * against a catalogue whose prices are 0 — and reading the real one needs a
   * reachable database, which a local checkout or an offline preview does not
   * have. This maps the loaded catalogue instead, so the free badges, the
   * banner, the missing star counts and the sort_order tiebreak can all be
   * checked without one. It changes nothing but this page's own copy of the
   * rows; the bench never sends.
   */
  const [forceFree, setForceFree] = useState(false);
  const [senderIndex, setSenderIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState('');
  const [latestGift, setLatestGift] = useState<LiveGiftEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  /**
   * Every timeout this page has scheduled.
   *
   * "เล่นครบ 7 ชั้น" spreads its sends over several seconds and "ยิงรัว 20"
   * over two; pressing either twice, or navigating away mid-run, would
   * otherwise leave orphaned timers firing into an unmounted tree. Cleared
   * before each run.
   */
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const sender = SENDERS[senderIndex];

  const tiers = useMemo(
    () => (forceFree ? loadedTiers.map((tier) => ({ ...tier, price_stars: 0 })) : loadedTiers),
    [loadedTiers, forceFree],
  );
  const catalogueIsFree = allTiersFree(tiers);

  const fire = useCallback(
    (tier: GiftTier, overrides?: Partial<LiveGiftEvent>) => {
      const qty = overrides?.quantity ?? quantity;
      const event: LiveGiftEvent = {
        // Unique per press, so the queue's de-duplication does not swallow the
        // second click on the same button. "ส่งซ้ำ id เดิม" reuses an id on
        // purpose, to prove de-duplication works.
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
        sort_order: tier.sort_order,
        quantity: qty,
        stars_total: tier.price_stars * qty,
        message: message.trim() === '' ? null : message.trim(),
        sender: { ...sender, avatar_url: null },
        created_at: new Date().toISOString(),
        ...overrides,
      };
      setLatestGift(event);
      setLog((current) =>
        [
          `${new Date().toLocaleTimeString('th-TH')} · ${event.name_en} ×${event.quantity} · ${
            event.stars_total > 0 ? `⭐${event.stars_total}` : 'ฟรี'
          } · ${event.sender.display_name}`,
          ...current,
        ].slice(0, 14),
      );
      return event;
    },
    [quantity, message, sender],
  );

  /** Gate: the same id twice must produce ONE animation. */
  const replayLast = useCallback(() => {
    if (!latestGift) return;
    setLatestGift({ ...latestGift, created_at: new Date().toISOString() });
    setLog((current) =>
      [`↻ ส่งซ้ำ ${latestGift.gift_id.slice(0, 14)} (ไม่ควรมีแถวใหม่)`, ...current].slice(0, 14),
    );
  }, [latestGift]);

  /**
   * Every tier, in catalogue order, spaced so each one is visible before the
   * next arrives.
   *
   * The tray tiers land immediately and the fullscreen tiers queue behind one
   * another, so the run takes as long as their durations add up to — which is
   * the point: it is the "show me all seven" pass, not a stress test.
   */
  const playAll = useCallback(() => {
    clearTimers();
    setLog((current) => [`▶ เล่นครบ ${tiers.length} ชั้น`, ...current].slice(0, 14));
    tiers.forEach((tier, index) => {
      later(() => fire(tier, { quantity: 1 }), index * SEQUENCE_GAP_MS);
    });
  }, [tiers, fire, clearTimers, later]);

  /** Gate 5: a Nova and a Comet inside the batch window — Nova must play first. */
  const novaThenComet = useCallback(() => {
    const nova = tiers.find((tier) => tier.animation_key === 'nova');
    const comet = tiers.find((tier) => tier.animation_key === 'comet');
    if (!comet || !nova) return;
    clearTimers();
    fire(comet, { quantity: 1 });
    // A real pair arrives milliseconds apart over the same socket; the timeout
    // is what makes them two separate enqueues rather than one render.
    later(() => fire(nova, { quantity: 1 }), 120);
  }, [tiers, fire, clearTimers, later]);

  /** Gate 4: three of the same gift in a row must be ONE tray row with ×3. */
  const comboBurst = useCallback(() => {
    const stardust = tiers.find((tier) => tier.animation_key === 'stardust') ?? tiers[0];
    clearTimers();
    fire(stardust, { quantity: 1 });
    later(() => fire(stardust, { quantity: 1 }), 250);
    later(() => fire(stardust, { quantity: 1 }), 500);
  }, [tiers, fire, clearTimers, later]);

  /** Twenty gifts across the catalogue, fast — the pending cap and shed order. */
  const flood = useCallback(
    (count: number) => {
      clearTimers();
      setLog((current) => [`▶ ยิงรัว ${count}`, ...current].slice(0, 14));
      for (let i = 0; i < count; i += 1) {
        const tier = tiers[i % tiers.length];
        later(() => fire(tier, { quantity: 1 }), i * 90);
      }
    },
    [tiers, fire, clearTimers, later],
  );

  const loadFromDatabase = useCallback(async () => {
    try {
      const supabase = getBrowserSupabase();
      const { tiers: rows, error } = await fetchGiftTiers(supabase);
      if (error || rows.length === 0) {
        setLog((current) => [`⚠ ${error ?? 'no active tiers'}`, ...current].slice(0, 14));
        return;
      }
      setLoadedTiers(rows);
      setTierSource('database');
      setLog((current) =>
        [`✓ โหลด ${rows.length} ชั้นจาก gift_tiers`, ...current].slice(0, 14),
      );
    } catch {
      setLog((current) =>
        ['⚠ Supabase ยังไม่ได้ตั้งค่าในสภาพแวดล้อมนี้', ...current].slice(0, 14),
      );
    }
  }, []);

  const quantities = useMemo(() => [1, 3, 10, 99], []);

  return (
    <main className="min-h-dvh bg-[#0a0a15] p-4 text-white">
      <h1 className="text-lg font-bold">Gift overlay bench</h1>
      <p className="mt-1 text-xs text-white/45">
        ไม่มีการหักดาวหรือเขียนฐานข้อมูล · tiers:{' '}
        <span className="font-semibold text-cyan-300">{tierSource}</span>
        {catalogueIsFree && <span className="ml-2 text-amber-300">· ทุกชั้นราคา 0 (โหมดทดสอบ)</span>}
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* The stand-in for a video player: the same relative box the overlay is
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
                      {isFreeTier(tier) ? 'ฟรี' : `⭐${tier.price_stars}`} · {tier.display_mode} ·{' '}
                      {tier.duration_ms}ms
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
            <p className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
              Quantity
            </p>
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
            <Bench label={`เล่นครบ ${tiers.length} ชั้น`} onClick={playAll} wide />
            <Bench label="Combo ×3" onClick={comboBurst} />
            <Bench label="Nova + Comet" onClick={novaThenComet} />
            <Bench label="ส่งซ้ำ id เดิม" onClick={replayLast} />
            <Bench label="ยิงรัว 20" onClick={() => flood(20)} />
            <Bench label="ยิงรัว 42" onClick={() => flood(42)} />
            <Bench label="หยุด" onClick={clearTimers} />
            <Bench label="เปิด drawer (ตัวอย่าง)" onClick={() => setDrawerOpen(true)} wide />
            <button
              type="button"
              onClick={() => setForceFree((current) => !current)}
              aria-pressed={forceFree}
              className={`col-span-2 min-h-11 rounded-xl border px-3 text-xs font-medium transition ${
                forceFree
                  ? 'border-amber-300/50 bg-amber-400/15 text-amber-100'
                  : 'border-white/12 bg-white/[0.04] text-white/75 hover:bg-white/[0.08]'
              }`}
            >
              {forceFree ? '✓ จำลองราคา 0 (โหมดทดสอบ)' : 'จำลองราคา 0 (โหมดทดสอบ)'}
            </button>
            <Bench label="โหลดจากฐานข้อมูล" onClick={() => void loadFromDatabase()} wide />
          </div>

          <ol className="max-h-44 space-y-1 overflow-y-auto border-t border-white/8 pt-3 text-[11px] text-white/40">
            {log.map((line, index) => (
              <li key={index} className="truncate">
                {line}
              </li>
            ))}
          </ol>
        </div>
      </div>

      {/*
        The real drawer, against the bench's catalogue — the only way to see the
        free badges, the "โหมดทดสอบ" banner and the always-enabled send button
        without a live session and a funded wallet. The balance is a fixed
        number rather than a wallet read; nothing here is the wallet.
      */}
      <GiftDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sessionId="00000000-0000-4000-8000-000000000000"
        tiers={tiers}
        tiersError={null}
        balance={12}
        onSent={(walletBalance) =>
          setLog((current) => [`✓ drawer onSent balance=${walletBalance}`, ...current].slice(0, 14))
        }
      />
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
