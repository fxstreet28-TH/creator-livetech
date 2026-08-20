'use client';
import { useState } from 'react';
import { X } from 'lucide-react';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { MobileBottomNav } from './MobileBottomNav';

interface DashboardShellProps {
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  children: React.ReactNode;
}

/**
 * Client shell that composes the dashboard chrome (TopBar + desktop Sidebar +
 * mobile drawer + bottom nav) around the server-rendered page content.
 */
export function DashboardShell({ displayName, email, avatarUrl, children }: DashboardShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-dvh bg-[#0a0a15] text-white">
      <TopBar
        displayName={displayName}
        email={email}
        avatarUrl={avatarUrl}
        onOpenDrawer={() => setDrawerOpen(true)}
      />

      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-60 shrink-0 overflow-y-auto border-r border-white/6 bg-[#0a0a15] md:block">
          <Sidebar />
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1 px-4 pb-20 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-6 md:px-8 md:pb-8">{children}</main>
      </div>

      <MobileBottomNav />

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div className="absolute left-0 top-0 h-full w-72 overflow-y-auto border-r border-white/8 bg-[#0a0a15] shadow-2xl">
            <div className="safe-top flex h-[calc(4rem+env(safe-area-inset-top))] items-center justify-between border-b border-white/6 px-4">
              <span className="text-sm font-semibold text-white/70">เมนู</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="ปิดเมนู"
                className="grid h-11 w-11 place-items-center rounded-lg text-white/60 hover:bg-white/5 hover:text-white"
              >
                <X size={20} />
              </button>
            </div>
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
