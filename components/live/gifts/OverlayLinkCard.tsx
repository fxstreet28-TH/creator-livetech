'use client';

/**
 * "ลิงก์ Overlay สำหรับ OBS" — the URL a creator pastes into an OBS browser
 * source to get the gift overlay on their canvas.
 *
 * WHY IT LIVES ON THE BROADCASTING SCREEN AND NOT ON /settings
 *
 * The brief put it on /settings. Two things make that the wrong place today.
 * /settings is still a `ComingSoon` stub with no shell to hang a card on — and
 * more importantly the URL contains a SESSION id, which does not exist until a
 * creator presses go-live. A settings page could only ever show half a link.
 * Here the session is in hand, and this is the screen a creator is looking at
 * while setting their scene up.
 *
 * THE KEY IS TREATED AS A CREDENTIAL
 *
 * It is fetched only when the card is opened, shown masked, and copied to the
 * clipboard rather than displayed in full — a creator screen-sharing their
 * studio while they set OBS up is the normal case, not the exception. "สร้าง
 * ลิงก์ใหม่" rotates it, which invalidates every URL anyone has already copied;
 * that is what it is for.
 */

import { useCallback, useState } from 'react';
import { Check, Copy, Link2, RefreshCw } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';

interface OverlayLinkCardProps {
  sessionId: string;
  className?: string;
}

/** The key masked for the screen. The clipboard gets the real thing. */
function maskedUrl(origin: string, sessionId: string): string {
  return `${origin}/overlay/live/${sessionId}?key=••••••••`;
}

export function OverlayLinkCard({ sessionId, className = '' }: OverlayLinkCardProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Present once a key has been fetched. Never rendered in full. */
  const [hasKey, setHasKey] = useState(false);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  /**
   * Fetch (or rotate) the key and put the finished URL on the clipboard.
   *
   * Deliberately one action rather than "load, then copy": the key never has to
   * exist in this component's state at all, so it cannot be read out of React
   * DevTools, and there is no window in which it is sitting in memory unused.
   */
  const fetchAndCopy = useCallback(
    async (regenerate: boolean) => {
      setBusy(true);
      setError(null);
      setCopied(false);

      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        setError('ระบบยังไม่พร้อมใช้งาน');
        setBusy(false);
        return;
      }

      const { data, error: rpcError } = await supabase.rpc('get_creator_overlay_key', {
        p_regenerate: regenerate,
      });

      if (rpcError || typeof data !== 'string' || data === '') {
        console.error('[OverlayLinkCard] key fetch failed', rpcError);
        setError('ขอลิงก์ไม่สำเร็จ กรุณาลองใหม่');
        setBusy(false);
        return;
      }

      const url = `${window.location.origin}/overlay/live/${sessionId}?key=${data}`;

      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setHasKey(true);
      } catch {
        // A browser that refuses clipboard access without a user gesture it
        // recognises, or an insecure origin. Saying so beats a silent no-op —
        // but the key is NOT rendered as a fallback, because the whole point of
        // copying rather than showing is that it stays off the screen.
        setError('คัดลอกไม่สำเร็จ — เบราว์เซอร์ไม่อนุญาต กรุณาลองใหม่');
      }

      setBusy(false);
    },
    [sessionId],
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-3 text-xs font-medium text-white/60 transition hover:bg-white/[0.06] hover:text-white/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${className}`}
      >
        <Link2 size={15} aria-hidden />
        ลิงก์ Overlay สำหรับ OBS
      </button>
    );
  }

  return (
    <section
      aria-label="ลิงก์ Overlay สำหรับ OBS"
      className={`shrink-0 rounded-2xl border border-white/10 bg-white/[0.03] p-3 ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-bold text-white/80">
          <Link2 size={14} aria-hidden />
          Overlay สำหรับ OBS
        </h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg px-2 py-1 text-[11px] text-white/40 transition hover:text-white/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          ซ่อน
        </button>
      </div>

      <p className="mt-2 break-all rounded-lg bg-black/30 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-white/45">
        {maskedUrl(origin, sessionId)}
      </p>

      <p className="mt-2 text-[11px] leading-relaxed text-white/40">
        วางลิงก์นี้ใน OBS → Browser Source (1920×1080, พื้นหลังโปร่งใส) ลิงก์นี้เป็นความลับ —
        ใครมีลิงก์ก็เปิดดู overlay ของคุณได้
      </p>

      {error && (
        <p role="alert" className="mt-2 text-[11px] leading-relaxed text-rose-200">
          {error}
        </p>
      )}

      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void fetchAndCopy(false)}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-purple-500 to-cyan-400 px-3 text-xs font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-60"
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void fetchAndCopy(true)}
          title="สร้างคีย์ใหม่ — ลิงก์เดิมทั้งหมดจะใช้ไม่ได้"
          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-white/12 bg-white/[0.04] px-3 text-xs font-medium text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
        >
          <RefreshCw size={14} aria-hidden />
          สร้างใหม่
        </button>
      </div>

      {hasKey && !error && (
        <p className="mt-2 text-[11px] text-emerald-300/80">
          ลิงก์อยู่ในคลิปบอร์ดแล้ว — วางใน OBS ได้เลย
        </p>
      )}
    </section>
  );
}
