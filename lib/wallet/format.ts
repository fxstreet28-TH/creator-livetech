/**
 * Display formatting for the wallet screens.
 *
 * Centralised so "110 บาท" is spelled one way across the buy screen, the
 * buyback form and the history list, and so the Bangkok timezone decision is
 * made once rather than per component.
 */

/** Star counts and THB totals: grouped, Latin digits (th-TH's default). */
const NUMBER_FORMAT = new Intl.NumberFormat('th-TH');

/**
 * Amounts: decimals only when they carry information. A 110 THB total reads
 * better as "110" than "110.00", and every purchase total is a whole number
 * of baht at any sane per-star price.
 */
const THB_FORMAT = new Intl.NumberFormat('th-TH', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/**
 * Rates: always two decimals. A per-star price is quoted to the satang in
 * star_pricing_config (11.00) and in buyback_requests' CHECK (3.00), and a
 * screen that renders those as "11" and "3" is quoting a rate in a different
 * shape from the one the money is denominated in. Totals use THB_FORMAT
 * above; only the "per Star" figures use this.
 */
const THB_RATE_FORMAT = new Intl.NumberFormat('th-TH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Bangkok, always — not the device timezone. A purchase timestamp is a fact
 * about a THB payment made in Thailand, and a user travelling abroad reading
 * their history against local time would be comparing it to a bank statement
 * that disagrees.
 */
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** 1234 -> "1,234" */
export function formatStars(stars: number): string {
  return NUMBER_FORMAT.format(stars);
}

/** 110 -> "110"   |   3 -> "3"   |   16.5 -> "16.5" */
export function formatThb(amount: number): string {
  return THB_FORMAT.format(amount);
}

/** 110 -> "110 บาท" */
export function formatThbWithUnit(amount: number): string {
  return `${formatThb(amount)} บาท`;
}

/** A per-star rate, always to the satang: 3 -> "3.00 บาท", 11 -> "11.00 บาท". */
export function formatThbRate(amount: number): string {
  return `${THB_RATE_FORMAT.format(amount)} บาท`;
}

/**
 * ISO timestamp -> "28 ส.ค. 2569 16:15" in Bangkok time.
 * Returns an em dash for null/unparseable input rather than "Invalid Date".
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_TIME_FORMAT.format(date);
}

/**
 * Mask a bank account number for display: keep the last 4 digits, mask the
 * rest in groups of three so it reads like an account number rather than a
 * blob. "1234567890" -> "XXX-XXX-7890".
 *
 * The full number is in the row the user themselves submitted, so this is
 * shoulder-surfing protection, not a security boundary.
 */
export function maskBankAccount(accountNumber: string | null | undefined): string {
  if (!accountNumber) return '—';
  const digits = accountNumber.replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  return `XXX-XXX-${digits.slice(-4)}`;
}

/** Seconds remaining -> "9:05". Clamps at zero; never renders a negative. */
export function formatCountdown(secondsRemaining: number): string {
  const safe = Math.max(0, Math.floor(secondsRemaining));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
