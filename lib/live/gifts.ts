'use client';

/**
 * Live gifts: the catalogue, the send call, and the wire format of a gift
 * event.
 *
 * The transport is the session's existing Realtime channel (`./realtime.ts`) —
 * a gift arrives as a `gift` broadcast alongside chat and reactions, so the
 * overlay needs no second subscription, no second presence entry and no second
 * authorisation path. What lives here is the domain: what a tier is, what an
 * event looks like on the wire, and how a viewer spends stars on one.
 *
 * PRICES ARE NEVER IN THIS FILE, OR IN ANY OTHER CLIENT FILE.
 *
 * `gift_tiers.price_stars` is placeholder pricing that the CEO will change with
 * an UPDATE, and `send_live_gift` prices every gift from that row. A constant
 * here would be a number the drawer displays and the database disagrees with —
 * so the drawer reads the catalogue, and the send call carries a tier id and a
 * count and no amount at all.
 *
 * WHAT A `gift` EVENT IS AND IS NOT
 *
 * It is written by `live_gifts_broadcast`, a database trigger on the INSERT, so
 * a real gift cannot be silently un-announced and an announced gift cannot have
 * failed to commit.
 *
 * It is NOT a signature. The `realtime.messages` INSERT policy lets anyone
 * entitled to watch the session put a message on the topic, which is what makes
 * chat work — and it means a modified client could also send something shaped
 * like a `gift`. That forges an ANIMATION, not a payment: no stars move, no
 * ledger row is written, and nothing the creator is paid on comes from this
 * channel. It is the same honest limit chat has (see the header of
 * ./realtime.ts), and the two defences are the same: every field is re-validated
 * and clamped on receive, so a hostile payload cannot render a ten-minute
 * animation or a screenful of text — and every number that is about MONEY is
 * read back from the database rather than taken from the event.
 * TODO(post-launch): sign gift events, or relay the channel through a function
 * that stamps them.
 */

import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';

export type GiftRarity = 'basic' | 'rare' | 'epic' | 'legendary' | 'mythic';
export type GiftDisplayMode = 'tray' | 'fullscreen';

/** `gift_tiers.animation_key`. Unknown keys fall back to the generic float. */
export type GiftAnimationKey = 'stardust' | 'moonlight' | 'comet' | 'nova' | 'generic';

const RARITIES: GiftRarity[] = ['basic', 'rare', 'epic', 'legendary', 'mythic'];

/** One row of the catalogue, as the drawer renders it. */
export interface GiftTier {
  id: number;
  slug: string;
  name_en: string;
  name_th: string;
  subtitle_th: string | null;
  rarity: GiftRarity;
  /** Authoritative. Placeholder values today; read, never assumed. */
  price_stars: number;
  animation_key: string;
  duration_ms: number;
  display_mode: GiftDisplayMode;
  max_quantity: number;
  sort_order: number;
}

/** Resolved server-side by the broadcast trigger, not claimed by the sender. */
export interface GiftSender {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

/** The `gift` broadcast payload, after validation. */
export interface LiveGiftEvent {
  gift_id: string;
  session_id: string;
  tier_id: number;
  tier_slug: string;
  name_en: string;
  name_th: string;
  rarity: GiftRarity;
  animation_key: string;
  display_mode: GiftDisplayMode;
  duration_ms: number;
  /**
   * `gift_tiers.sort_order` — the tier's rank in the catalogue.
   *
   * Carried so the fullscreen queue can order two gifts that cost the SAME,
   * which in free-preview mode is every pair of gifts. Without it the
   * most-valuable-first rule ties on every comparison and the queue degrades to
   * plain FIFO.
   */
  sort_order: number;
  quantity: number;
  stars_total: number;
  message: string | null;
  sender: GiftSender;
  created_at: string;
}

/** The `live_gifts` row `live-send-gift` echoes back. */
export interface LiveGiftRow {
  id: string;
  session_id: string;
  creator_id: string;
  sender_id: string;
  tier_id: number;
  quantity: number;
  stars_total: number;
  message: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Mirrors the CHECK on live_gifts.message. */
export const MAX_GIFT_MESSAGE_LENGTH = 80;

/**
 * Clamps applied to a RECEIVED event.
 *
 * These are not the database's limits restated for convenience — they are what
 * stops a forged payload from holding the screen. `duration_ms` is the one that
 * matters most: a fullscreen gift blocks the queue behind it for exactly this
 * long, so an unclamped value is a denial of the overlay for everyone watching.
 *
 * The ceiling MIRRORS the CHECK on `gift_tiers.duration_ms` rather than sitting
 * under it. A clamp tighter than the database's own limit does not make
 * anything safer — the worst a forgery can do is what a real row is already
 * allowed to do — and it silently truncates legitimate tiers: tier 07's clip
 * runs 42.2s, so a 15s clamp would have cut its animation off two thirds of the
 * way through while the queue held the screen for the full 42 anyway. When the
 * migration moves the CHECK, move this with it.
 */
const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 45_000;
const MAX_QUANTITY = 999;
const MAX_STARS_TOTAL = 5_000_000;
const MAX_NAME_LENGTH = 40;

/** The quantity chips in the drawer. Clamped to the tier's own max_quantity. */
export const GIFT_QUANTITY_PRESETS = [1, 5, 10, 99];

/**
 * FREE PREVIEW
 *
 * A tier priced at 0 is free: `send_live_gift` skips the spend, the creator
 * credit and the AML star ceiling, and writes no ledger row. There is no flag
 * anywhere — the PRICE is the switch, so a tier the CEO reprices with one
 * `UPDATE` stops being free everywhere at once, including in every string
 * below, with no deploy.
 *
 * Everything that reads these helpers therefore branches on DATA, never on an
 * environment variable or a build-time constant. That is what makes the paid
 * launch a SQL statement rather than a release.
 */
export function isFreeTier(tier: Pick<GiftTier, 'price_stars'>): boolean {
  return tier.price_stars <= 0;
}

/**
 * True when the whole visible catalogue is free.
 *
 * Drives the drawer's "โหมดทดสอบ" banner, and only that: it is a statement
 * about the CATALOGUE, so a mixed catalogue (some tiers priced, some not)
 * correctly stops showing it while individual free tiers keep their own badge.
 * An empty catalogue is not "all free" — there is nothing to be free.
 */
export function allTiersFree(tiers: GiftTier[]): boolean {
  return tiers.length > 0 && tiers.every(isFreeTier);
}

/**
 * The `+N ⭐` fragment, or null when nothing was spent.
 *
 * Every surface that mentions a gift's value goes through this, so "a free gift
 * shows no star count" is one decision in one place rather than five `> 0`
 * checks that will drift. `+0 ⭐` is worse than nothing: it reads as a gift that
 * failed to charge rather than one that was free by design.
 */
export function starsFragment(starsTotal: number): string | null {
  return starsTotal > 0 ? `+${starsTotal.toLocaleString('th-TH')} ⭐` : null;
}

/**
 * Rarity → the tint a tray row, a drawer card and a chat line are painted with.
 *
 * One table, three consumers. Rarity is the only thing that varies between
 * tiers visually, and having each component decide for itself is how a Nova
 * ends up gold in the tray and purple in the chat.
 */
export interface RarityStyle {
  /** Tailwind classes for a bordered, tinted surface. */
  surface: string;
  /** Tailwind text colour for the tier's name. */
  text: string;
  /** A raw CSS colour, for the animation stages' custom properties. */
  glow: string;
}

export const RARITY_STYLES: Record<GiftRarity, RarityStyle> = {
  basic: {
    surface: 'border-cyan-300/35 bg-cyan-400/10',
    text: 'text-cyan-200',
    glow: '#6ee6ff',
  },
  rare: {
    surface: 'border-purple-300/40 bg-purple-500/12',
    text: 'text-purple-200',
    glow: '#b08cff',
  },
  epic: {
    surface: 'border-amber-300/45 bg-amber-400/12',
    text: 'text-amber-200',
    glow: '#ffce5c',
  },
  legendary: {
    surface: 'border-orange-300/50 bg-gradient-to-r from-amber-400/15 to-purple-500/15',
    text: 'text-orange-200',
    glow: '#ffb478',
  },
  mythic: {
    surface: 'border-amber-100/55 bg-gradient-to-r from-amber-100/15 to-cyan-200/12',
    text: 'text-amber-100',
    glow: '#fff4c4',
  },
};

export function rarityStyle(rarity: string): RarityStyle {
  return RARITY_STYLES[(RARITIES as string[]).includes(rarity) ? (rarity as GiftRarity) : 'basic'];
}

// ---------------------------------------------------------------------------
// Reading the catalogue
// ---------------------------------------------------------------------------

const TIER_COLUMNS =
  'id, slug, name_en, name_th, subtitle_th, rarity, price_stars, animation_key, ' +
  'duration_ms, display_mode, max_quantity, sort_order';

/**
 * The active tiers, in display order.
 *
 * Read with the browser client rather than through an Edge Function: the table
 * has a SELECT-only grant and a policy that already narrows it to
 * `is_active = true`, so the database is what scopes the rows, and a function
 * in front of it would add a hop and a second place for the filter to be wrong.
 * Same reasoning as the purchases and buybacks reads in useWalletHistory.
 */
export async function fetchGiftTiers(
  supabase: SupabaseClient,
): Promise<{ tiers: GiftTier[]; error: string | null }> {
  const { data, error } = await supabase
    .from('gift_tiers')
    .select(TIER_COLUMNS)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) {
    console.error('[live/gifts] gift_tiers read failed', error);
    return { tiers: [], error: 'โหลดรายการของขวัญไม่สำเร็จ กรุณาลองใหม่' };
  }

  // Cast because the column list is a concatenated constant: PostgREST's typed
  // client cannot infer a row shape from a string it did not see literally, and
  // widens the result to its error union instead. Same reason lib/live/api.ts
  // hands its rows to a `Record<string, unknown>` mapper.
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return { tiers: rows.map(toTier), error: null };
}

function toTier(row: Record<string, unknown>): GiftTier {
  const rarity = String(row.rarity ?? '');
  const mode = String(row.display_mode ?? '');
  return {
    id: Number(row.id),
    slug: String(row.slug ?? ''),
    name_en: String(row.name_en ?? ''),
    name_th: String(row.name_th ?? ''),
    subtitle_th:
      typeof row.subtitle_th === 'string' && row.subtitle_th.trim() !== ''
        ? row.subtitle_th
        : null,
    rarity: (RARITIES as string[]).includes(rarity) ? (rarity as GiftRarity) : 'basic',
    price_stars: Number(row.price_stars ?? 0),
    animation_key: String(row.animation_key ?? 'generic'),
    duration_ms: Number(row.duration_ms ?? 4500),
    display_mode: mode === 'fullscreen' ? 'fullscreen' : 'tray',
    max_quantity: Number(row.max_quantity ?? 99),
    sort_order: Number(row.sort_order ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendGiftRequest {
  session_id: string;
  tier_id: number;
  quantity: number;
  message?: string;
}

export interface SendGiftResponse {
  gift: LiveGiftRow;
  wallet_balance: number;
}

export interface GiftError {
  /** The code `live-send-gift` answered, or a local pseudo-code. */
  code: string;
  /** Thai, user-facing. Safe to render as-is. */
  message: string;
  /** Present on INSUFFICIENT_STARS — what the drawer needs for its top-up CTA. */
  balance?: number;
  required?: number;
  /** Present on QUANTITY_TOO_HIGH. */
  maxQuantity?: number;
  status?: number;
}

/**
 * Thai for every refusal the function can answer with.
 *
 * Kept here rather than in lib/live/api.ts because the vocabularies do not
 * overlap: nothing there is about a wallet, and nothing here is about an egress
 * or a CDN playlist. That is the same reason api.ts is not merged into
 * wallet/invoke.ts.
 */
const GIFT_ERROR_TH: Record<string, string> = {
  SESSION_NOT_LIVE: 'ไลฟ์จบแล้ว',
  SELF_GIFT: 'ส่งของขวัญให้ตัวเองไม่ได้',
  TIER_INACTIVE: 'ของขวัญชิ้นนี้ปิดให้บริการแล้ว',
  QUANTITY_TOO_HIGH: 'จำนวนเกินที่กำหนด',
  INSUFFICIENT_STARS: 'ดาวไม่พอ',
  RATE_LIMITED: 'ส่งเร็วเกินไป รอสักครู่',
  INVALID_INPUT: 'ข้อมูลไม่ถูกต้อง',
  unauthenticated: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  network_error: 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
};

const GIFT_UNKNOWN_ERROR: GiftError = {
  code: 'internal_error',
  message: 'ส่งของขวัญไม่สำเร็จ กรุณาลองใหม่',
};

function numberFrom(source: unknown, key: string): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function parseGiftError(response: Response): Promise<GiftError> {
  try {
    const body = await response.json();
    const envelope = body?.error;
    if (envelope && typeof envelope === 'object') {
      const code = typeof envelope.code === 'string' ? envelope.code : '';
      const detail = envelope.detail;
      return {
        code: code || 'internal_error',
        message: GIFT_ERROR_TH[code] ?? GIFT_UNKNOWN_ERROR.message,
        balance: numberFrom(detail, 'balance'),
        required: numberFrom(detail, 'required'),
        maxQuantity: numberFrom(detail, 'max_quantity'),
        status: response.status,
      };
    }
  } catch {
    // An HTML error page from the platform rather than a function response.
  }
  if (response.status === 401) {
    return { code: 'unauthenticated', message: GIFT_ERROR_TH.unauthenticated, status: 401 };
  }
  return { ...GIFT_UNKNOWN_ERROR, status: response.status };
}

/**
 * Spend stars on a gift. Never throws.
 *
 * No optimistic overlay follows a 200. The animation is played from the
 * broadcast the INSERT produced, so the sender sees exactly what the creator
 * and every other viewer sees, at the same moment — an optimistic render would
 * make the sender's screen the one screen that can disagree with the room.
 */
export async function sendLiveGift(
  supabase: SupabaseClient,
  payload: SendGiftRequest,
): Promise<{ data: SendGiftResponse | null; error: GiftError | null }> {
  const message = payload.message?.trim() ?? '';

  try {
    const { data, error } = await supabase.functions.invoke<SendGiftResponse>('live-send-gift', {
      method: 'POST',
      body: {
        session_id: payload.session_id,
        tier_id: payload.tier_id,
        quantity: payload.quantity,
        ...(message !== '' ? { message: message.slice(0, MAX_GIFT_MESSAGE_LENGTH) } : {}),
      },
    });

    if (error) {
      if (error instanceof FunctionsHttpError && error.context instanceof Response) {
        return { data: null, error: await parseGiftError(error.context) };
      }
      return {
        data: null,
        error: { code: 'network_error', message: GIFT_ERROR_TH.network_error },
      };
    }

    return { data: data ?? null, error: null };
  } catch (err) {
    console.error('[live/gifts] live-send-gift failed', err);
    return { data: null, error: { code: 'network_error', message: GIFT_ERROR_TH.network_error } };
  }
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Read an arbitrary broadcast payload as a gift event, or null.
 *
 * Every field is checked and bounded — see the header for why a payload on this
 * channel is untrusted even though the honest one comes from a trigger. An
 * event missing an id is dropped outright rather than defaulted: `gift_id` is
 * what the queue de-duplicates on, and a synthesised one would defeat that on
 * exactly the reconnect replay it exists to catch.
 */
export function decodeGiftEvent(raw: unknown): LiveGiftEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const giftId = typeof source.gift_id === 'string' ? source.gift_id.slice(0, 64) : '';
  const sessionId = typeof source.session_id === 'string' ? source.session_id.slice(0, 64) : '';
  if (giftId === '' || sessionId === '') return null;

  const senderRaw = (source.sender ?? {}) as Record<string, unknown>;
  const rarity = String(source.rarity ?? '');
  const avatar = senderRaw.avatar_url;

  return {
    gift_id: giftId,
    session_id: sessionId,
    tier_id: clampInt(source.tier_id, 0, 32767, 0),
    tier_slug: text(source.tier_slug, 40),
    name_en: text(source.name_en, MAX_NAME_LENGTH) || 'Gift',
    name_th: text(source.name_th, MAX_NAME_LENGTH) || 'ของขวัญ',
    rarity: (RARITIES as string[]).includes(rarity) ? (rarity as GiftRarity) : 'basic',
    animation_key: text(source.animation_key, 40) || 'generic',
    display_mode: source.display_mode === 'fullscreen' ? 'fullscreen' : 'tray',
    duration_ms: clampInt(source.duration_ms, MIN_DURATION_MS, MAX_DURATION_MS, 4500),
    sort_order: clampInt(source.sort_order, 0, 32767, 0),
    quantity: clampInt(source.quantity, 1, MAX_QUANTITY, 1),
    stars_total: clampInt(source.stars_total, 0, MAX_STARS_TOTAL, 0),
    message: text(source.message, MAX_GIFT_MESSAGE_LENGTH).trim() || null,
    sender: {
      id: typeof senderRaw.id === 'string' ? senderRaw.id.slice(0, 64) : '',
      display_name: text(senderRaw.display_name, MAX_NAME_LENGTH) || 'ผู้ชม',
      // Only an http(s) URL. A `javascript:` or `data:` value would be handed
      // straight to an <img src>, and the avatar is attacker-influenced in
      // exactly the way the rest of this payload is.
      avatar_url:
        typeof avatar === 'string' && /^https?:\/\//i.test(avatar) ? avatar.slice(0, 500) : null,
    },
    created_at: typeof source.created_at === 'string' ? source.created_at : new Date().toISOString(),
  };
}

/**
 * The chat line a gift writes.
 *
 * One line per EVENT, with that event's own quantity — not per tray row. The
 * tray combines a rapid run of the same gift into one row with a ×N; the chat
 * log is a log, and collapsing three sends into one line there would lose the
 * order they arrived in relative to everything else being said.
 */
export function giftChatLine(event: LiveGiftEvent): string {
  const stars = starsFragment(event.stars_total);
  const suffix = stars === null ? '' : ` (${stars})`;
  return `🎁 ${event.sender.display_name} ส่ง ${event.name_th} ×${event.quantity}${suffix}`;
}
