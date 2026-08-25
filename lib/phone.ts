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
 * Normalises a raw phone value to E.164 for sending over the wire.
 *
 * Unlike formatPhoneE164 this never returns null: an unparseable value comes
 * back stripped of formatting characters so the server-side validator stays
 * the single place that rejects bad input.
 *
 * The trunk prefix ('0' in Thailand, the UK, Japan, ...) is dropped by
 * libphonenumber-js as part of parsing, so a Thai user typing the local
 * '0614929599' and one typing '614929599' both end up as '+66614929599'.
 * Country data drives this, so numbers from every country the picker offers
 * are normalised by their own rules rather than Thailand's.
 *
 * Cases covered (verified against libphonenumber-js; no test runner in this
 * repo yet, so they live here until one is added):
 *   '0614929599'      -> '+66614929599'   local format, trunk 0 stripped
 *   '+66614929599'    -> '+66614929599'   already E.164, untouched
 *   '+660614929599'   -> '+66614929599'   stray 0 after the dial code
 *   '66614929599'     -> '+66614929599'   dial code without the '+'
 *   '614929599'       -> '+66614929599'   bare, already trunk-stripped
 *   '061-492-9599'    -> '+66614929599'   punctuation ignored
 *   ' 0614929599 '    -> '+66614929599'   surrounding whitespace ignored
 *   '00614929599'     -> '+66614929599'   doubled trunk 0 (see below)
 *   '+4407911123456'  -> '+447911123456'  UK trunk 0, not treated as Thai
 *   '+66' / '' / 'x'  -> passthrough, left for the server to reject
 */
export function normalizePhoneE164(input: string, defaultCountry: CountryCode = 'TH'): string {
  if (!input) return '';

  const direct = formatPhoneE164(input, defaultCountry);
  if (direct) return direct;

  // A run of leading zeros is almost always a doubled trunk prefix, but '00'
  // is also Thailand's international dialing prefix, so libphonenumber reads
  // '00614929599' as an IDD call and gives up. Retry once with the run
  // collapsed to a single trunk 0, and only take it if that parses cleanly.
  // This runs after the direct attempt so a number libphonenumber can already
  // read on its own is never second-guessed by this heuristic.
  const cleaned = input.replace(/[^\d+]/g, '');
  if (/^0{2,}\d+$/.test(cleaned)) {
    const collapsed = formatPhoneE164(cleaned.replace(/^0+/, '0'), defaultCountry);
    if (collapsed) return collapsed;
  }

  return cleaned;
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

/**
 * Thailand-bound convenience over normalizePhoneE164, for callers that know
 * they are handling a Thai local number.
 */
export const normalizeThaiPhone = (input: string) => normalizePhoneE164(input, 'TH');
