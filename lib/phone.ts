/**
 * Client-safe phone helpers (no server-only deps) so both the browser form and
 * the server routes share one source of truth for phone parsing/validation.
 * Backed by libphonenumber-js so numbers from any country are supported.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Parses and validates a phone number in any country.
 * Returns E.164 format (with '+') on success, null on invalid input.
 * @param input Raw phone number (may include country code or not)
 * @param defaultCountry ISO 3166-1 alpha-2 country code, e.g. 'TH', 'US', 'GB'
 */
export function formatPhoneE164(input: string, defaultCountry: CountryCode = 'TH'): string | null {
  if (!input) return null;
  try {
    const parsed = parsePhoneNumberFromString(input, defaultCountry);
    if (!parsed || !parsed.isValid()) return null;
    return parsed.format('E.164');
  } catch {
    return null;
  }
}

/**
 * Returns a masked display for a phone number in its own country's national
 * format, keeping the country code and the last 4 digits visible.
 * e.g. '+66994247994' → '+66 XXX XXX 7994'. Used in the Step 2 verify UI.
 */
export function maskPhoneDisplay(e164: string): string {
  try {
    const parsed = parsePhoneNumberFromString(e164);
    if (!parsed) return e164;
    const national = parsed.formatNational();
    const totalDigits = (national.match(/\d/g) ?? []).length;
    // Mask every digit except the last 4, preserving the country's spacing.
    let seen = 0;
    const masked = national.replace(/\d/g, (d) => {
      seen += 1;
      return seen <= totalDigits - 4 ? 'X' : d;
    });
    return `+${parsed.countryCallingCode} ${masked}`;
  } catch {
    return e164;
  }
}

/**
 * Backward-compat alias for callers that still validate Thai numbers by name.
 * Prefer formatPhoneE164 going forward.
 */
export const formatThaiPhoneE164 = (input: string) => formatPhoneE164(input, 'TH');
