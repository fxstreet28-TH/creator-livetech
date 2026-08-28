'use client';

/**
 * Common frame for the wallet screens: app background, a back link, a title,
 * and a centred column sized for a phone first.
 *
 * These pages sit outside app/dashboard, so they get no sidebar or bottom
 * nav — deliberately. Buying stars and requesting a buyback are focused,
 * one-way tasks, and a bottom bar inviting a tap to "ค้นพบ" halfway through a
 * payment is an invitation to abandon it. A single explicit back link is the
 * affordance a task flow wants.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

interface WalletPageShellProps {
  title: string;
  subtitle?: string;
  /** Where the back link goes. Defaults to the wallet overview. */
  backHref?: string;
  backLabel?: string;
  children: React.ReactNode;
}

export function WalletPageShell({
  title,
  subtitle,
  backHref = '/wallet',
  backLabel = 'กลับไปที่ Wallet',
  children,
}: WalletPageShellProps) {
  return (
    <main className="min-h-dvh bg-[#0a0a15] text-white">
      <div className="safe-top mx-auto w-full max-w-lg px-4 pb-16 pt-6 sm:px-6">
        <Link
          href={backHref}
          className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm text-white/55 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          {/* Rotated rather than a separate ArrowLeft import: one icon, and
              it stays consistent if the icon set changes. */}
          <ArrowRight size={16} className="rotate-180" aria-hidden />
          {backLabel}
        </Link>

        <header className="mb-6 mt-4">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-white/50">{subtitle}</p>}
        </header>

        {children}
      </div>
    </main>
  );
}
