// Mock data for the user dashboard (v1). No backend wiring — these seed the
// LiveNowCarousel, RecommendedCreators, and RecentActivity sections until real
// data lands in a later task. Relative timestamps are computed against a fixed
// MOCK_NOW so the "X นาทีที่แล้ว" labels render identically on server and client
// (no hydration mismatch, no drift over time).

export interface MockCreator {
  id: string;
  handle: string;
  displayName: string;
  category: string;
  avatarUrl: string; // DiceBear avataaars
  subscriberCount: number;
}

export interface MockLiveSession {
  id: string;
  creatorId: string;
  title: string;
  category: string;
  viewerCount: number;
  startedAt: string; // ISO
}

export interface MockActivity {
  id: string;
  creatorId: string;
  type: 'live_started' | 'content_posted' | 'new_subscriber';
  title: string;
  timestamp: string; // ISO
}

/** Fixed "now" reference so relative-time labels are deterministic. */
export const MOCK_NOW = '2026-08-06T12:00:00.000Z';

const avatar = (seed: string) =>
  `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(seed)}`;

export const mockCreators: MockCreator[] = [
  {
    id: 'c1',
    handle: 'por_aurum',
    displayName: 'อ.ปอ AURUM',
    category: 'Traders & Analysis',
    avatarUrl: avatar('por-aurum'),
    subscriberCount: 12400,
  },
  {
    id: 'c2',
    handle: 'mae_mor_som',
    displayName: 'แม่หมอส้ม',
    category: 'ดูดวง & Spiritual',
    avatarUrl: avatar('mae-mor-som'),
    subscriberCount: 8600,
  },
  {
    id: 'c3',
    handle: 'cryptoking_th',
    displayName: 'CryptoKing TH',
    category: 'Crypto & Web3',
    avatarUrl: avatar('cryptoking-th'),
    subscriberCount: 21800,
  },
  {
    id: 'c4',
    handle: 'coach_ann',
    displayName: 'โค้ชแอน',
    category: 'Business & Coaching',
    avatarUrl: avatar('coach-ann'),
    subscriberCount: 5400,
  },
  {
    id: 'c5',
    handle: 'nong_wellness',
    displayName: 'น้องเวลเนส',
    category: 'Wellness',
    avatarUrl: avatar('nong-wellness'),
    subscriberCount: 3300,
  },
  {
    id: 'c6',
    handle: 'kru_fah_edu',
    displayName: 'ครูฟ้า Education',
    category: 'Education',
    avatarUrl: avatar('kru-fah-edu'),
    subscriberCount: 9700,
  },
  {
    id: 'c7',
    handle: 'trader_beam',
    displayName: 'เทรดเดอร์บีม',
    category: 'Traders & Analysis',
    avatarUrl: avatar('trader-beam'),
    subscriberCount: 15200,
  },
  {
    id: 'c8',
    handle: 'p_mind_spirit',
    displayName: 'พี่มายด์ Spiritual',
    category: 'ดูดวง & Spiritual',
    avatarUrl: avatar('p-mind-spirit'),
    subscriberCount: 6100,
  },
];

export const mockLiveSessions: MockLiveSession[] = [
  {
    id: 'l1',
    creatorId: 'c1',
    title: 'วิเคราะห์ทองคำ & ค่าเงินบาทเช้านี้',
    category: 'Traders & Analysis',
    viewerCount: 3240,
    startedAt: '2026-08-06T11:12:00.000Z',
  },
  {
    id: 'l2',
    creatorId: 'c3',
    title: 'อัปเดตตลาด Crypto + ถาม-ตอบสด',
    category: 'Crypto & Web3',
    viewerCount: 5820,
    startedAt: '2026-08-06T11:30:00.000Z',
  },
  {
    id: 'l3',
    creatorId: 'c2',
    title: 'ดูดวงความรักรายสัปดาห์',
    category: 'ดูดวง & Spiritual',
    viewerCount: 1470,
    startedAt: '2026-08-06T11:40:00.000Z',
  },
  {
    id: 'l4',
    creatorId: 'c4',
    title: 'เวิร์กช็อป: วางแผนธุรกิจ 90 วัน',
    category: 'Business & Coaching',
    viewerCount: 890,
    startedAt: '2026-08-06T11:05:00.000Z',
  },
  {
    id: 'l5',
    creatorId: 'c6',
    title: 'ติวเลข ม.ปลาย ก่อนสอบ',
    category: 'Education',
    viewerCount: 2110,
    startedAt: '2026-08-06T11:50:00.000Z',
  },
  {
    id: 'l6',
    creatorId: 'c7',
    title: 'เปิดพอร์ต & กลยุทธ์เทรดสั้น',
    category: 'Traders & Analysis',
    viewerCount: 4360,
    startedAt: '2026-08-06T11:22:00.000Z',
  },
];

export const mockActivities: MockActivity[] = [
  {
    id: 'a1',
    creatorId: 'c3',
    type: 'live_started',
    title: 'อัปเดตตลาด Crypto + ถาม-ตอบสด',
    timestamp: '2026-08-06T11:55:00.000Z',
  },
  {
    id: 'a2',
    creatorId: 'c1',
    type: 'content_posted',
    title: 'สรุปแนวรับแนวต้านทองคำประจำวัน',
    timestamp: '2026-08-06T11:48:00.000Z',
  },
  {
    id: 'a3',
    creatorId: 'c2',
    type: 'live_started',
    title: 'ดูดวงความรักรายสัปดาห์',
    timestamp: '2026-08-06T11:35:00.000Z',
  },
  {
    id: 'a4',
    creatorId: 'c6',
    type: 'content_posted',
    title: 'ชีตสรุปสูตรคณิตศาสตร์ ม.6',
    timestamp: '2026-08-06T11:10:00.000Z',
  },
  {
    id: 'a5',
    creatorId: 'c4',
    type: 'new_subscriber',
    title: 'เปิดรับสมาชิกรุ่นใหม่ประจำเดือน',
    timestamp: '2026-08-06T10:30:00.000Z',
  },
];

/** Look up a creator by id (used to resolve avatars/names in feeds). */
export function getCreator(id: string): MockCreator | undefined {
  return mockCreators.find((c) => c.id === id);
}

/** "12.4k" style compact count. */
export function formatCompact(n: number): string {
  if (n >= 1000) {
    const v = n / 1000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return String(n);
}

/** Thai relative-time label, e.g. "5 นาทีที่แล้ว". Deterministic vs MOCK_NOW. */
export function formatRelativeThai(fromISO: string, nowISO: string = MOCK_NOW): string {
  const diffMs = new Date(nowISO).getTime() - new Date(fromISO).getTime();
  const mins = Math.max(0, Math.round(diffMs / 60000));
  if (mins < 1) return 'เมื่อสักครู่';
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ชั่วโมงที่แล้ว`;
  const days = Math.round(hours / 24);
  return `${days} วันที่แล้ว`;
}
