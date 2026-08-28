'use client';

/**
 * /wallet — balance, the two things you can do with it, and history.
 *
 * Replaces the ComingSoon placeholder. The two primary actions sit above the
 * fold on a phone, because they are the only reasons this screen exists.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowUpRight, Plus } from 'lucide-react';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useWalletSummary } from '@/lib/hooks/useWalletSummary';
import { WalletHistory, type HistoryTab } from '@/components/wallet/WalletHistory';
import { formatDateTime, formatStars } from '@/lib/wallet/format';
import { MIN_BUYBACK_STARS } from '@/lib/constants/stars';

const VALID_TABS: HistoryTab[] = ['all', 'purchases', 'buyback'];

/**
 * Ties the unavailable Buyback button to the sentence explaining why. A
 * literal rather than useId() because it is referenced across two sibling
 * branches of the same render and only ever appears once on the page.
 */
const BUYBACK_HINT_ID = 'wallet-buyback-hint';

/**
 * Reads ?tab= so the buyback confirmation's "ดูประวัติ buyback" link lands on
 * the right tab. useSearchParams suspends during prerender, so this is split
 * out and wrapped below — without the boundary the whole page would have to
 * opt out of static generation, which the Capacitor export cannot do.
 */
function HistorySection() {
  const params = useSearchParams();
  const requested = params.get('tab');
  const initialTab = VALID_TABS.includes(requested as HistoryTab)
    ? (requested as HistoryTab)
    : 'all';
  return <WalletHistory initialTab={initialTab} />;
}

export default function WalletPage() {
  const { ready } = useRequireAuth();
  const wallet = useWalletSummary();

  if (!ready) return <AuthPending />;

  const nextExpiry = wallet.upcomingExpirations[0] ?? null;
  const canBuyback = wallet.balance >= MIN_BUYBACK_STARS;

  return (
    <main className="min-h-dvh bg-[#0a0a15] text-white">
      <div className="safe-top mx-auto w-full max-w-2xl px-4 pb-16 pt-6 sm:px-6">
        <header className="mb-6">
          <p className="text-xs tracking-[0.2em] text-purple-300">AURUM LIVE</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">กระเป๋าเงิน</h1>
        </header>

        <section
          aria-label="ยอดคงเหลือ"
          className="rounded-3xl border border-purple-500/25 bg-gradient-to-br from-purple-600/25 to-pink-600/15 p-6"
        >
          <p className="text-sm text-white/60">ยอดคงเหลือ</p>
          {wallet.loading ? (
            <div className="mt-2 h-11 w-40 animate-pulse rounded-lg bg-white/10" />
          ) : (
            <p className="mt-1 text-4xl font-extrabold tabular-nums">
              {formatStars(wallet.balance)}
              <span className="ml-2 text-base font-semibold text-white/60">Stars</span>
            </p>
          )}

          {!wallet.loading && nextExpiry && (
            <p className="mt-3 text-xs text-white/50">
              {formatStars(nextExpiry.remaining_stars)} Stars จะหมดอายุ{' '}
              {formatDateTime(nextExpiry.expires_at)}
            </p>
          )}

          {wallet.error && (
            <p role="alert" className="mt-3 text-xs text-amber-200">
              {wallet.error.message}
            </p>
          )}
        </section>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/wallet/buy-stars"
            className="inline-flex min-h-[3.25rem] flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-4 text-base font-extrabold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <Plus size={18} aria-hidden />
            ซื้อ Stars
          </Link>

          {/* A link when there is something to sell, an inert button when
              there is not: routing to a form that can only reject the user is
              worse than saying so here.

              aria-disabled rather than the `disabled` attribute, and a button
              rather than a span, so the control stays in the tab order — a
              screen reader user should be able to reach it and hear both that
              it is unavailable and, via aria-describedby, why. A `disabled`
              button would simply vanish from the tab order with no
              explanation. */}
          {canBuyback ? (
            <Link
              href="/wallet/buyback"
              className="inline-flex min-h-[3.25rem] flex-1 items-center justify-center gap-2 rounded-2xl border border-white/12 bg-white/[0.04] px-5 py-4 text-base font-bold text-white/85 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              <ArrowUpRight size={18} aria-hidden />
              Buyback
            </Link>
          ) : (
            <button
              type="button"
              aria-disabled="true"
              aria-describedby={BUYBACK_HINT_ID}
              onClick={(event) => event.preventDefault()}
              className="inline-flex min-h-[3.25rem] flex-1 cursor-not-allowed items-center justify-center gap-2 rounded-2xl border border-white/8 px-5 py-4 text-base font-bold text-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              <ArrowUpRight size={18} aria-hidden />
              Buyback
            </button>
          )}
        </div>

        {!wallet.loading && !canBuyback && (
          <p id={BUYBACK_HINT_ID} className="mt-2 text-center text-xs text-white/35">
            ต้องมีอย่างน้อย {formatStars(MIN_BUYBACK_STARS)} Stars จึงจะขาย buyback ได้
          </p>
        )}

        <Suspense fallback={null}>
          <HistorySection />
        </Suspense>

        <Link
          href="/dashboard"
          className="mt-10 inline-flex min-h-11 items-center rounded-xl px-2 text-sm text-white/45 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          ← กลับแดชบอร์ด
        </Link>
      </div>
    </main>
  );
}
