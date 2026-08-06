'use client';
import { PhoneInput as IntlPhoneInput } from 'react-international-phone';
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

export function PhoneInput({ value, onChange, error, defaultCountry = 'th' }: PhoneInputProps) {
  return (
    <div className={`intl-phone-wrapper ${error ? 'intl-phone-wrapper-error' : ''}`}>
      <IntlPhoneInput
        defaultCountry={defaultCountry}
        value={value}
        onChange={(phone) => onChange(phone)}
        preferredCountries={['th', 'sg', 'my', 'id', 'ph', 'vn', 'us', 'gb', 'jp', 'kr']}
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
