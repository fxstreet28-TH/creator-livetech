/**
 * Value formatting for the transactional emails.
 *
 * Every date the customer sees is Bangkok time. The rows these emails are
 * rendered from store timestamptz, which arrives here as UTC, and a
 * purchase made at 01:00 Bangkok would otherwise be dated the previous
 * day in the receipt.
 */

const BKK_TZ = 'Asia/Bangkok';

/** "29 Aug 2026 · 14:05" */
export function formatBangkokDateTime(iso: string | Date): string {
  const d = toDate(iso);
  const date = d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: BKK_TZ,
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: BKK_TZ,
  });
  return `${date} · ${time}`;
}

/** "29 Aug 2026" */
export function formatBangkokDate(iso: string | Date): string {
  return toDate(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: BKK_TZ,
  });
}

/** "29 AUG 2026" — the eyebrow date in the header rule. */
export function formatBangkokDateUppercase(iso: string | Date): string {
  return formatBangkokDate(iso).toUpperCase();
}

/**
 * Add whole days in Bangkok terms. Used for the "if you have not seen the
 * deposit by" line, which is a courtesy deadline and not a business-day
 * calculation — 2 calendar days, deliberately generous.
 */
export function addDays(iso: string | Date, days: number): Date {
  return new Date(toDate(iso).getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * "PAY-4F2A1B9C" — the first segment of the uuid, which is what support
 * asks for over the phone. Full ids are unreadable aloud and the segment
 * is enough to find the row.
 */
export function formatShortRef(prefix: string, id: string): string {
  return `${prefix}-${id.split('-')[0].toUpperCase()}`;
}

/** Money, always two decimals: "1,650.00". */
export function formatThb(n: number | string): string {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (!Number.isFinite(num)) return '0.00';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** star_purchases.payment_method, as the customer would name it. */
export function paymentMethodLabel(method: string): string {
  const map: Record<string, string> = {
    stripe: 'Card',
    promptpay: 'PromptPay',
    inet_promptpay: 'PromptPay',
    oxapay: 'Crypto',
    crypto: 'Crypto',
    manual_admin: 'Manual Credit',
  };
  return map[method] ?? method;
}

/** buyback_requests.bank_name holds the short code the wallet UI collects. */
export function bankLabel(code: string): string {
  const map: Record<string, string> = {
    SCB: 'Siam Commercial Bank',
    KBANK: 'Kasikornbank',
    BBL: 'Bangkok Bank',
    KTB: 'Krungthai Bank',
    BAY: 'Bank of Ayudhya',
    TTB: 'TMBThanachart Bank',
    GSB: 'Government Savings Bank',
    UOB: 'United Overseas Bank',
    CIMB: 'CIMB Thai',
  };
  return map[code?.toUpperCase() ?? ''] ?? code ?? '';
}

/**
 * Everything interpolated into an email body goes through this. Bank
 * account names and rejection reasons are typed by hand in the ops CRM,
 * so they are as untrusted as any other user input.
 */
export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toDate(iso: string | Date): Date {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
