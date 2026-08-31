'use client';

/**
 * Common frame for the three public viewer pages: aurora background, an
 * optional back link, a gradient title, and a centred column.
 *
 * Same shape and reasoning as CreatorPageShell and WalletPageShell — this repo
 * gives each section its own shell rather than one configurable layout.
 * CreatorPageShell is not reused directly because these pages are public: it
 * is capped at ~1000px for a two-column form, always renders a back link, and
 * lives in the creator namespace, none of which fits a feed an anonymous
 * visitor lands on from a shared URL.
 *
 * These pages sit outside app/dashboard deliberately. DashboardChrome runs
 * useRequireAuth, so wrapping them in the sidebar would bounce every signed-out
 * visitor to /login — and a public feed that demands a login is not a public
 * feed.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

type ShellWidth = 'feed' | 'detail';

const WIDTH_CLASS: Record<ShellWidth, string> = {
  /** Three cards at ~340px plus gutters. */
  feed: 'max-w-6xl',
  detail: 'max-w-5xl',
};

interface ViewerPageShellProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  width?: ShellWidth;
  /** Suppress the <h1>, for pages that paint their own header (a cover). */
  bare?: boolean;
  children: React.ReactNode;
}

export function ViewerPageShell({
  title,
  subtitle,
  backHref,
  backLabel,
  width = 'feed',
  bare = false,
  children,
}: ViewerPageShellProps) {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-[#0a0a15] text-white">
      {/* Static aurora wash, matching the creator and auth screens: painted
          once, never touches the main thread again. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-[-25%] blur-[40px]"
        style={{
          background:
            'radial-gradient(38% 32% at 20% 18%, rgba(139, 92, 246, 0.28), transparent 70%),' +
            'radial-gradient(40% 34% at 82% 84%, rgba(6, 182, 212, 0.20), transparent 70%),' +
            'radial-gradient(32% 26% at 52% 50%, rgba(236, 72, 153, 0.10), transparent 70%)',
        }}
      />

      <div
        className={`safe-top safe-x relative mx-auto w-full ${WIDTH_CLASS[width]} px-4 pb-24 pt-6 sm:px-6`}
      >
        {backHref && (
          <Link
            href={backHref}
            className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm text-white/55 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <ArrowRight size={16} className="rotate-180" aria-hidden />
            {backLabel ?? 'กลับ'}
          </Link>
        )}

        {!bare && (
          <header className={backHref ? 'mb-6 mt-4' : 'mb-6'}>
            <h1 className="bg-gradient-to-r from-purple-300 to-cyan-300 bg-clip-text text-2xl font-bold tracking-tight text-transparent sm:text-3xl">
              {title}
            </h1>
            {subtitle && <p className="mt-1 text-sm text-white/50">{subtitle}</p>}
          </header>
        )}

        {children}
      </div>
    </main>
  );
}
