'use client';

/**
 * What /wallet/buyback renders while BUYBACK_USER_ENABLED is off.
 *
 * The route stays mounted rather than 404-ing: users have the URL from PR
 * #28, from their own history, and from anyone who shared it, and a 404 tells
 * them the feature is broken when in fact it moved to a support channel.
 *
 * Reuses the /login aurora shell (.aurum-auth*) rather than WalletPageShell.
 * This is a dead end, not a step in a task — the wallet frame's back link and
 * task chrome would suggest there is something here to do.
 */

import Link from 'next/link';
import { Browser } from '@capacitor/browser';
import { Mail, MessageCircle } from 'lucide-react';
import { isNative } from '@/lib/config';

/** LINE Official account, as published on the site's support channels. */
const LINE_ID = '@aurumlive';
const LINE_URL = 'https://line.me/R/ti/p/@aurumlive';
const SUPPORT_EMAIL = 'support@creatorlivetech.com';

export function BuybackClosedNotice() {
  async function handleOpenLine(event: React.MouseEvent<HTMLAnchorElement>) {
    // Same reason as PromptPayQR's bank-app hand-off: a plain href inside the
    // Capacitor WebView navigates the shell away from the app instead of
    // opening LINE.
    if (!isNative()) return;
    event.preventDefault();
    await Browser.open({ url: LINE_URL });
  }

  return (
    <main className="aurum-auth">
      <div className="aurum-auth__aurora" aria-hidden />

      <div className="aurum-auth__card">
        <small className="aurum-auth__badge">Buyback</small>
        <h1 className="aurum-auth__title">Buyback ยังไม่เปิดให้บริการ</h1>
        <p className="aurum-auth__subtitle">
          ขณะนี้บริการ buyback อยู่ระหว่างการปรับปรุง หากต้องการขาย Stars คืน
          กรุณาติดต่อทีมงานผ่านช่องทางด้านล่าง
        </p>

        <div className="mt-6 flex flex-col gap-2 text-left">
          <a
            href={LINE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleOpenLine}
            className="flex min-h-11 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/85 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <MessageCircle size={18} className="shrink-0 text-emerald-300" aria-hidden />
            <span className="min-w-0">
              <span className="block text-xs text-white/45">LINE Official</span>
              <span className="block truncate font-medium">{LINE_ID}</span>
            </span>
          </a>

          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="flex min-h-11 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/85 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <Mail size={18} className="shrink-0 text-purple-300" aria-hidden />
            <span className="min-w-0">
              <span className="block text-xs text-white/45">อีเมล</span>
              <span className="block truncate font-medium">{SUPPORT_EMAIL}</span>
            </span>
          </a>
        </div>

        <Link href="/wallet" className="aurum-auth__submit">
          กลับไปที่ Wallet
        </Link>
      </div>
    </main>
  );
}
