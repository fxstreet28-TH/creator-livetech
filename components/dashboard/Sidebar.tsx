'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { NAV_ITEMS } from './nav';

interface SidebarProps {
  /** Called after a nav item is clicked (used to close the mobile drawer). */
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <nav className="flex h-full flex-col gap-1 p-4">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
              active
                ? 'bg-purple-500/15 font-medium text-purple-200'
                : 'text-white/60 hover:bg-white/5 hover:text-white'
            }`}
          >
            <span className="relative grid place-items-center">
              <Icon size={20} />
              {item.live && (
                <span className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-red-500" />
              )}
            </span>
            {item.label}
          </Link>
        );
      })}

      <hr className="my-4 border-white/6" />

      <div className="mt-auto rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-600/30 to-pink-600/20 p-4">
        <p className="text-sm font-bold text-white">อยากสร้างรายได้?</p>
        <p className="mt-1 text-xs leading-relaxed text-white/60">
          เปิดพื้นที่ของคุณ รับสมาชิกและรายได้
        </p>
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            router.push('/creator/apply');
          }}
          className="mt-3 w-full rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 py-2.5 text-sm font-extrabold text-white transition hover:shadow-lg hover:shadow-purple-500/40"
        >
          สมัครเป็น Creator →
        </button>
      </div>
    </nav>
  );
}
