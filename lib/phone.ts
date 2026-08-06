/**
 * Client-safe Thai phone helpers (no server-only deps) so both the browser
 * form and the server routes share one source of truth for phone parsing.
 */

/**
 * Normalise a Thai mobile number to E.164 (+66XXXXXXXXX).
 * Accepts local "08X-XXX-XXXX" (with/without leading 0) or an international
 * "66..." form. Thai mobiles start with 6, 8, or 9 after the leading 0.
 * Returns null if the input is not a valid Thai mobile number.
 */
export function formatThaiPhoneE164(input: string): string | null {
  const digits = input.replace(/\D/g, '');

  if (digits.startsWith('66')) {
    const rest = digits.slice(2);
    if (rest.length === 9 && /^[689]/.test(rest)) return `+66${rest}`;
    return null;
  }
  if (digits.startsWith('0') && digits.length === 10 && /^0[689]/.test(digits)) {
    return `+66${digits.slice(1)}`;
  }
  if (digits.length === 9 && /^[689]/.test(digits)) {
    return `+66${digits}`;
  }
  return null;
}
