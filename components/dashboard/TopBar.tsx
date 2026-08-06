'use client';
import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { Bell, Search, Menu, User, Settings, LogOut } from 'lucide-react';
import { Avatar } from './Avatar';

interface TopBarProps {
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  onOpenDrawer: () => void;
}

export function TopBar({ displayName, email, avatarUrl, onOpenDrawer }: TopBarProps) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  async function logout() {
    setMenuOpen(false);
    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
      await supabase.auth.signOut();
    } catch {
      // best-effort; still send the user to /login
    }
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/6 bg-[#0a0a15]/85 px-4 backdrop-blur-md md:px-6">
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={onOpenDrawer}
        aria-label="เปิดเมนู"
        className="grid h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/5 hover:text-white md:hidden"
      >
        <Menu size={22} />
      </button>

      {/* Logo */}
      <Link href="/dashboard" className="flex shrink-0 items-center">
        <Image src="/aurum-live-logo.png" alt="AURUM Live" width={100} height={67} priority />
      </Link>

      {/* Search (desktop) */}
      <div className="mx-auto hidden w-full max-w-lg md:block">
        <div className="flex items-center gap-2 rounded-full border border-white/8 bg-[#14142b] px-4 py-2">
          <Search size={16} className="text-white/40" />
          <input
            type="text"
            placeholder="ค้นหา Creator หรือหมวดหมู่..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') console.log('search:', (e.target as HTMLInputElement).value);
            }}
            className="w-full bg-transparent text-sm text-white placeholder:text-white/40 focus:outline-none"
          />
        </div>
      </div>

      {/* Right actions */}
      <div className="ml-auto flex items-center gap-2 md:gap-4">
        <button
          type="button"
          aria-label="การแจ้งเตือน"
          className="relative hidden h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/5 hover:text-white sm:grid"
        >
          <Bell size={20} />
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-red-500" />
        </button>

        <span className="hidden items-center rounded-full border border-white/8 bg-gradient-to-r from-purple-500/20 to-pink-500/20 px-3 py-1.5 text-sm font-medium text-white sm:inline-flex">
          ฿0
        </span>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="เมนูบัญชี"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex items-center rounded-full transition hover:opacity-90"
          >
            <Avatar name={displayName} src={avatarUrl} size={32} ring />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-11 w-52 overflow-hidden rounded-xl border border-white/10 bg-[#14142b] shadow-2xl"
            >
              <div className="border-b border-white/6 px-4 py-3">
                <p className="truncate text-sm font-semibold text-white">{displayName}</p>
                {email && <p className="truncate text-xs text-white/50">{email}</p>}
              </div>
              <MenuLink href="/settings" icon={<User size={16} />} onClick={() => setMenuOpen(false)}>
                โปรไฟล์
              </MenuLink>
              <MenuLink href="/settings" icon={<Settings size={16} />} onClick={() => setMenuOpen(false)}>
                ตั้งค่า
              </MenuLink>
              <button
                type="button"
                role="menuitem"
                onClick={logout}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-red-300 transition hover:bg-white/5"
              >
                <LogOut size={16} />
                ออกจากระบบ
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function MenuLink({
  href,
  icon,
  children,
  onClick,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onClick}
      className="flex items-center gap-3 px-4 py-2.5 text-sm text-white/80 transition hover:bg-white/5 hover:text-white"
    >
      {icon}
      {children}
    </Link>
  );
}
