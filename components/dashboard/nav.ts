import {
  Home,
  Compass,
  Radio,
  Heart,
  Star,
  Wallet,
  MessageCircle,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Show a small live/pulse indicator on this item. */
  live?: boolean;
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

/** Five most-used destinations for the mobile bottom bar. */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  { label: 'หน้าหลัก', href: '/dashboard', icon: Home },
  { label: 'ค้นพบ', href: '/discover', icon: Compass },
  { label: 'ไลฟ์', href: '/live', icon: Radio, live: true },
  { label: 'ติดตาม', href: '/following', icon: Heart },
  { label: 'กระเป๋า', href: '/wallet', icon: Wallet },
];
