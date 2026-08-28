'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BOTTOM_NAV_ITEMS, isNavItemActive } from './nav';

export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex h-[calc(4rem+env(safe-area-inset-bottom))] items-stretch border-t border-white/6 bg-[#0a0a15]/95 backdrop-blur-md md:hidden">
      {BOTTOM_NAV_ITEMS.map((item) => {
        const active = isNavItemActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-1 flex-col items-center justify-center gap-1 text-[11px] transition ${
              active ? 'text-purple-300' : 'text-white/55'
            }`}
          >
            <span className="relative grid place-items-center">
              <Icon size={20} />
              {item.live && (
                <span className="absolute -right-1 -top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
              )}
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
