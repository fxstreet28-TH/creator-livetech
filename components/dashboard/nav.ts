import {
  Home,
  Compass,
  Radio,
  Heart,
  Star,
  Wallet,
  MessageCircle,
  Settings,
  Upload,
  ListVideo,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Show a small live/pulse indicator on this item. */
  live?: boolean;
}

/**
 * Whether a nav item should render as the current destination.
 *
 * Was `pathname === item.href`, which is right until a section has
 * subroutes. /wallet/buy-stars and /wallet/buyback are the first, and under
 * an exact match the whole nav goes dark while the user is inside the wallet
 * — nothing looks selected, so nothing tells them where they are.
 *
 * The `/` boundary is required rather than a bare startsWith: /discover must
 * not light up for a future /discover-creators.
 *
 * Trailing slashes are normalised because the Capacitor build sets
 * `trailingSlash: true`, so the exported route for /wallet is /wallet/ — a
 * comparison against the unslashed href in NAV_ITEMS would never match there.
 */
export function isNavItemActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  const strip = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);
  const current = strip(pathname);
  const target = strip(href);
  return current === target || current.startsWith(`${target}/`);
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'หน้าหลัก', href: '/dashboard', icon: Home },
  { label: 'ค้นพบ', href: '/discover', icon: Compass },
  { label: 'กำลังไลฟ์', href: '/live', icon: Radio, live: true },
  { label: 'ติดตามอยู่', href: '/following', icon: Heart },
  { label: 'สมาชิกของฉัน', href: '/subscriptions', icon: Star },
  { label: 'กระเป๋าเงิน', href: '/wallet', icon: Wallet },
  { label: 'ข้อความ', href: '/messages', icon: MessageCircle },
  { label: 'ตั้งค่า', href: '/settings', icon: Settings },
];

/**
 * Creator Studio — shown only to a user who has a row in `creators`.
 *
 * Its own group under a heading rather than two more entries appended to
 * NAV_ITEMS: these are authoring tools, not places to watch things, and a
 * "อัปโหลดวิดีโอ" sitting directly under "ตั้งค่า" reads as another account
 * setting. The group is gated by useCreatorProfile in <Sidebar>, so a viewer
 * never sees a link to a page that would only tell them to apply.
 *
 * Deliberately NOT added to BOTTOM_NAV_ITEMS: the mobile bar is five fixed
 * slots for everyone, and the creator screens live outside the dashboard
 * chrome anyway (CreatorPageShell renders no bottom bar).
 */
export const CREATOR_NAV_ITEMS: NavItem[] = [
  { label: 'อัปโหลดวิดีโอ', href: '/creator/upload', icon: Upload },
  { label: 'โพสต์ของฉัน', href: '/creator/posts', icon: ListVideo },
  // Distinct from the viewer-side 'กำลังไลฟ์' (/live) above: that is where you
  // watch, this is where you broadcast. isNavItemActive matches on a `/`
  // boundary, so /creator/live never lights up /live and vice versa.
  { label: 'ไลฟ์สด', href: '/creator/live', icon: Radio, live: true },
];

/** Five most-used destinations for the mobile bottom bar. */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  { label: 'หน้าหลัก', href: '/dashboard', icon: Home },
  { label: 'ค้นพบ', href: '/discover', icon: Compass },
  { label: 'ไลฟ์', href: '/live', icon: Radio, live: true },
  { label: 'ติดตาม', href: '/following', icon: Heart },
  { label: 'กระเป๋า', href: '/wallet', icon: Wallet },
];
