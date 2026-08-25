'use client';
import {
  PhoneInput as IntlPhoneInput,
  buildCountryData,
  defaultCountries,
  parseCountry,
} from 'react-international-phone';
import 'react-international-phone/style.css';

interface PhoneInputProps {
  value: string; // E.164 format from state, e.g. '+66994247994'
  onChange: (e164: string) => void; // callback with new E.164
  error?: boolean;
  // Default country stays Thailand (bulk of users); extend as we expand.
  defaultCountry?: 'th' | 'us' | 'gb' | 'sg' | 'my' | 'id' | 'ph' | 'vn' | 'jp' | 'kr';
}

// Match the modal's redesigned input treatment (bg #0a0a12, border #353145,
// rounded 13). The purple focus ring is applied via globals.css (:focus can't
// be expressed inline).
const FIELD_BG = '#0a0a12';
const FIELD_BORDER = '1px solid #353145';
const FIELD_RADIUS = '13px';

// The library ships no formatting mask for Thailand, so Thai numbers fall back
// to the 12-digit default mask — two digits more than any Thai number has, and
// the mask is what caps the input length. Give TH its own 10-slot mask
// ('061 492 9599') so the field can't hold more digits than a Thai number can,
// and so the local format the user recognises is what they see. Ten covers the
// trunk 0 users habitually type; typing without it just leaves a slot unused.
// Every other country keeps the library's own data untouched.
const TH_MASK = '... ... ....';
const countries = defaultCountries.map((country) => {
  const parsed = parseCountry(country);
  return parsed.iso2 === 'th' ? buildCountryData({ ...parsed, format: TH_MASK }) : country;
});

/**
 * Signup phone field.
 *
 * The dial code is locked (`forceDialCode`): it is rendered inside the input
 * but keyboard events can never remove or edit it. Before this, backspacing
 * past the digits ate the '+66' and left malformed values like '+9' or '',
 * which sailed through the form and only failed later at SMS OTP send with a
 * confusing error. The country is still changeable through the selector
 * dropdown (and by pasting another country's international number, which is
 * the library's documented behaviour for `forceDialCode` and the one we want:
 * a user pasting '+447911123456' gets the UK, not a mangled Thai number).
 *
 * Everything else the field needs is already handled by the library's mask and
 * needs no props of ours:
 *   - non-digits are dropped on both typing and paste (mask only accepts digits)
 *   - length is capped by the current country's mask, so we must NOT set a
 *     maxLength — 10 is a Thai number and would truncate longer countries
 *   - `pattern="[0-9]*"` is deliberately absent: the value here is the full
 *     formatted international number ('+66 061 492 9599'), so a digits-only
 *     pattern would mark a perfectly valid field `:invalid`. `inputMode="tel"`
 *     gives the numeric keypad on mobile without that side effect.
 *
 * Behaviour checked against the running signup modal in a headless browser
 * (no test runner in this repo yet, so the cases live here as documentation,
 * same as lib/phone.ts):
 *   backspace x10 on '+66 061 492 9599' -> '+66', dial code intact
 *   select-all + delete                 -> '+66', dial code intact
 *   type 'abcdef'                       -> nothing entered
 *   type '0614929599'                   -> '+66 061 492 9599'
 *   type '06149295991234'               -> '+66 061 492 9599', mask-capped
 *   paste '(+66) 061-492-9599 abc'      -> digits only, mask-capped
 *   pick GB in the selector             -> '+44', also locked
 *   type '0929296875' then submit       -> '+66929296875' on the wire;
 *                                          normalizePhoneE164() in
 *                                          useSignupFlow.ts still does that
 *                                          normalisation, not duplicated here
 *   submit with the digits empty        -> inline 'เบอร์โทรศัพท์ไม่ถูกต้อง',
 *                                          never a silent pass to SMS
 */
export function PhoneInput({ value, onChange, error, defaultCountry = 'th' }: PhoneInputProps) {
  return (
    <div className={`intl-phone-wrapper ${error ? 'intl-phone-wrapper-error' : ''}`}>
      <IntlPhoneInput
        defaultCountry={defaultCountry}
        value={value}
        onChange={(phone) => onChange(phone)}
        forceDialCode
        countries={countries}
        preferredCountries={['th', 'sg', 'my', 'id', 'ph', 'vn', 'us', 'gb', 'jp', 'kr']}
        inputProps={{
          // The <label> in Step1Credentials is not wired up with htmlFor/id
          // (the library owns the input's id), so name the field explicitly.
          'aria-label': 'เบอร์โทรศัพท์',
          autoComplete: 'tel',
          inputMode: 'tel',
        }}
        inputStyle={{
          width: '100%',
          background: FIELD_BG,
          color: '#fff',
          border: FIELD_BORDER,
          borderRadius: FIELD_RADIUS,
          padding: '14px 15px',
          fontSize: '15px',
          outline: 'none',
        }}
        countrySelectorStyleProps={{
          buttonStyle: {
            background: FIELD_BG,
            border: FIELD_BORDER,
            borderRadius: FIELD_RADIUS,
            height: 'auto',
            padding: '0 8px',
          },
          dropdownStyleProps: {
            style: {
              background: '#14142b',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '13px',
              color: '#fff',
            },
          },
        }}
      />
    </div>
  );
}
