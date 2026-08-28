'use client';

/**
 * Where the buyback money goes: bank, account number, account holder name.
 *
 * Presentational and fully controlled. Every rule enforced here is also
 * enforced by buyback-request — the digit-stripping in particular is done on
 * both sides, because the server is what decides what gets stored and the
 * client is what stops a user submitting a form they were always going to be
 * told off for.
 */

import { useId } from 'react';
import { MAX_ACCOUNT_DIGITS, MIN_ACCOUNT_DIGITS, THAI_BANKS } from '@/lib/constants/thaiBanks';

export interface BankDetails {
  bankCode: string;
  accountNumber: string;
  accountName: string;
}

export interface BankFieldErrors {
  bankCode?: string | null;
  accountNumber?: string | null;
  accountName?: string | null;
}

interface BankAccountFieldsProps {
  value: BankDetails;
  onChange: (next: BankDetails) => void;
  errors: BankFieldErrors;
  disabled?: boolean;
}

export function BankAccountFields({
  value,
  onChange,
  errors,
  disabled = false,
}: BankAccountFieldsProps) {
  const bankId = useId();
  const accountId = useId();
  const nameId = useId();
  const bankErrorId = useId();
  const accountErrorId = useId();
  const nameErrorId = useId();
  const accountHintId = useId();
  const nameHintId = useId();

  const fieldClass = (invalid: boolean) =>
    `min-h-11 w-full rounded-xl border bg-[#0a0a12] px-4 py-3 text-base text-white transition placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50 ${
      invalid ? 'border-red-500/60' : 'border-white/10 focus:border-purple-400'
    }`;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <label htmlFor={bankId} className="mb-2 block text-sm font-medium text-white/70">
          ธนาคาร
        </label>
        <select
          id={bankId}
          value={value.bankCode}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, bankCode: event.target.value })}
          aria-invalid={errors.bankCode ? true : undefined}
          aria-describedby={errors.bankCode ? bankErrorId : undefined}
          className={fieldClass(Boolean(errors.bankCode))}
        >
          <option value="">เลือกธนาคาร</option>
          {THAI_BANKS.map((bank) => (
            <option key={bank.code} value={bank.code}>
              {bank.name}
            </option>
          ))}
        </select>
        {errors.bankCode && (
          <p id={bankErrorId} role="alert" className="mt-2 text-sm text-red-300">
            {errors.bankCode}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={accountId} className="mb-2 block text-sm font-medium text-white/70">
          เลขที่บัญชีธนาคาร
        </label>
        <input
          id={accountId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value.accountNumber}
          disabled={disabled}
          // Stripped as the user types rather than on blur. A passbook prints
          // "123-4-56789-0", so the dashes get typed; removing them on blur
          // would let the field show a length the digit counter disagrees
          // with while it is being filled in.
          onChange={(event) =>
            onChange({ ...value, accountNumber: event.target.value.replace(/\D/g, '') })
          }
          maxLength={MAX_ACCOUNT_DIGITS}
          aria-invalid={errors.accountNumber ? true : undefined}
          aria-describedby={errors.accountNumber ? accountErrorId : accountHintId}
          className={fieldClass(Boolean(errors.accountNumber))}
          placeholder="1234567890"
        />
        {errors.accountNumber ? (
          <p id={accountErrorId} role="alert" className="mt-2 text-sm text-red-300">
            {errors.accountNumber}
          </p>
        ) : (
          <p id={accountHintId} className="mt-2 text-xs text-white/40">
            กรอกเฉพาะตัวเลข {MIN_ACCOUNT_DIGITS}-{MAX_ACCOUNT_DIGITS} หลัก (ไม่ต้องใส่ขีด)
          </p>
        )}
      </div>

      <div>
        <label htmlFor={nameId} className="mb-2 block text-sm font-medium text-white/70">
          ชื่อเจ้าของบัญชี
        </label>
        <input
          id={nameId}
          type="text"
          autoComplete="name"
          value={value.accountName}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, accountName: event.target.value })}
          aria-invalid={errors.accountName ? true : undefined}
          aria-describedby={errors.accountName ? nameErrorId : nameHintId}
          className={fieldClass(Boolean(errors.accountName))}
          placeholder="ชื่อ นามสกุล"
        />
        {errors.accountName ? (
          <p id={nameErrorId} role="alert" className="mt-2 text-sm text-red-300">
            {errors.accountName}
          </p>
        ) : (
          <p id={nameHintId} className="mt-2 text-xs text-white/40">
            ต้องตรงกับชื่อในบัญชีธนาคาร
          </p>
        )}
      </div>
    </div>
  );
}
