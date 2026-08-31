/**
 * Display formatting for the creator content screens.
 *
 * Separate from lib/wallet/format.ts, which is about money and Bangkok-time
 * payment records. Nothing here is money; the two share a locale, not a
 * concern. Date/time reuses formatDateTime from the wallet module rather than
 * defining a second Bangkok formatter.
 */

/** 0 -> "0:00", 95 -> "1:35", 3725 -> "1:02:05". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** 15_728_640 -> "15.0 MB". Decimal MB/GB, the unit a phone's file picker shows. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

const COUNT_FORMAT = new Intl.NumberFormat('th-TH');

/** 1234 -> "1,234". Same shape as the wallet's star counts. */
export function formatCount(value: number | null | undefined): string {
  return COUNT_FORMAT.format(Number(value ?? 0));
}

/** Full Bangkok-time date, for the detail screen. */
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatPostDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_TIME_FORMAT.format(date);
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Relative Thai time for list cards: "เมื่อสักครู่", "3 ชั่วโมงที่แล้ว",
 * "2 วันที่แล้ว", then an absolute date past a week.
 *
 * Hand-rolled rather than `date-fns`, which is not a dependency — pulling a
 * date library in for one string would fail the "check package.json first"
 * rule for the sake of eleven lines. Thai has no plural forms, so the naive
 * "{n} {unit}ที่แล้ว" is correct at every n.
 */
export function formatRelativeThai(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  // A clock skew between the browser and Postgres can put created_at a few
  // seconds in the future; "just now" is the honest reading, not "-1 hours".
  if (seconds < MINUTE) return 'เมื่อสักครู่';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)} นาทีที่แล้ว`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)} ชั่วโมงที่แล้ว`;
  if (seconds < 7 * DAY) return `${Math.floor(seconds / DAY)} วันที่แล้ว`;
  return formatPostDateTime(iso);
}
