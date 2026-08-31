'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCreatorProfile } from '@/lib/hooks/useCreatorProfile';
import { CREATOR_NAV_ITEMS, NAV_ITEMS, isNavItemActive, type NavItem } from './nav';

interface SidebarProps {
  /** Called after a nav item is clicked (used to close the mobile drawer). */
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  // A user with no `creators` row gets neither the Creator Studio group nor a
  // link into it — /creator/upload would only tell them to apply. While the
  // lookup is in flight creatorId is null, so the group fades in rather than
  // appearing and disappearing.
  const { creatorId } = useCreatorProfile();
  const isCreator = creatorId !== null;

  const renderItem = (item: NavItem) => {
    const active = isNavItemActive(pathname, item.href);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${
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
  };

  return (
    <nav className="flex h-full flex-col gap-1 p-4">
      {NAV_ITEMS.map(renderItem)}

      {isCreator && (
        <>
          <hr className="my-3 border-white/6" />
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-white/35">
            Creator Studio
          </p>
          {CREATOR_NAV_ITEMS.map(renderItem)}
        </>
      )}

      {/* The apply CTA is for people who are not creators yet; a creator who
          already has a studio group above does not need to be invited to
          apply again — and the divider goes with it, so the nav does not end
          on a rule with nothing under it. */}
      {!isCreator && (
        <>
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
              className="mt-3 w-full rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 py-3 text-sm font-extrabold text-white transition hover:shadow-lg hover:shadow-purple-500/40"
            >
              สมัครเป็น Creator →
            </button>
          </div>
        </>
      )}
    </nav>
  );
}
