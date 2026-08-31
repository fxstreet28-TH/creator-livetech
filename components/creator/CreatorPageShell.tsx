'use client';

/**
 * Common frame for the creator content screens: aurora background, a back
 * link, a page title, and a centred column.
 *
 * Same shape and reasoning as WalletPageShell — these pages sit outside
 * app/dashboard so they get no sidebar or bottom nav, because uploading is a
 * focused task and a bottom bar inviting a tap to "ค้นพบ" halfway through a
 * 200 MB upload is an invitation to lose it. WalletPageShell itself is not
 * reused: it is fixed at max-w-lg, and the upload screen is a two-column
 * layout that needs roughly twice that.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

type ShellWidth = 'form' | 'wide';

const WIDTH_CLASS: Record<ShellWidth, string> = {
  // ~1000px, the brief's max width for the two-column upload layout.
  wide: 'max-w-[62.5rem]',
  form: 'max-w-3xl',
};

interface CreatorPageShellProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  width?: ShellWidth;
  /** Rendered on the title row, right-aligned — e.g. the upload CTA. */
  action?: React.ReactNode;
  children: React.ReactNode;
}

export function CreatorPageShell({
  title,
  subtitle,
  backHref = '/dashboard',
  backLabel = 'กลับแดชบอร์ด',
  width = 'form',
  action,
  children,
}: CreatorPageShellProps) {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-[#0a0a15] text-white">
      {/* Static aurora wash, matching the auth screens: painted once, never
          touches the main thread again — which matters on a page that is
          simultaneously pushing bytes to a CDN. */}
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
        <Link
          href={backHref}
          className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm text-white/55 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <ArrowRight size={16} className="rotate-180" aria-hidden />
          {backLabel}
        </Link>

        <header className="mb-6 mt-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="bg-gradient-to-r from-purple-300 to-cyan-300 bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              {title}
            </h1>
            {subtitle && <p className="mt-1 text-sm text-white/50">{subtitle}</p>}
          </div>
          {action}
        </header>

        {children}
      </div>
    </main>
  );
}
