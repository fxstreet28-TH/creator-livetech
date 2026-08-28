/**
 * Thai banks offered in the buyback form.
 *
 * A closed list, not free text. `code` is what goes into
 * buyback_requests.bank_name, and an admin reads that column to make the
 * transfer by hand — so "SCB", "scb", "ไทยพาณิชย์" and "Siam Commercial Bank"
 * arriving as four spellings of one bank is a payout problem, not a cosmetic
 * one. The dropdown is the enforcement.
 *
 * `name` is display only. It leads with the Thai name because that is what is
 * printed on the passbook the user is reading the account number off, with
 * the familiar Latin abbreviation after it.
 */

export interface ThaiBank {
  /** Stored in buyback_requests.bank_name. Short, stable, admin-facing. */
  code: string;
  /** Rendered in the dropdown. Never stored. */
  name: string;
}

export const THAI_BANKS: ThaiBank[] = [
  { code: 'SCB', name: 'ธนาคารไทยพาณิชย์ (SCB)' },
  { code: 'KBANK', name: 'ธนาคารกสิกรไทย (KBank)' },
  { code: 'BBL', name: 'ธนาคารกรุงเทพ (BBL)' },
  { code: 'KTB', name: 'ธนาคารกรุงไทย (KTB)' },
  { code: 'BAY', name: 'ธนาคารกรุงศรีอยุธยา (Krungsri)' },
  { code: 'TTB', name: 'ธนาคารทหารไทยธนชาต (TTB)' },
  { code: 'GSB', name: 'ธนาคารออมสิน (GSB)' },
  { code: 'BAAC', name: 'ธนาคารเพื่อการเกษตรฯ (BAAC)' },
  { code: 'CIMB', name: 'ธนาคาร CIMB Thai' },
  { code: 'UOB', name: 'ธนาคาร UOB' },
  { code: 'TISCO', name: 'ธนาคารทิสโก้' },
  { code: 'KKP', name: 'ธนาคารเกียรตินาคินภัทร (KKP)' },
  { code: 'LH', name: 'ธนาคารแลนด์แอนด์เฮ้าส์' },
];

/** Digit-count bounds mirrored from buyback-request/index.ts. */
export const MIN_ACCOUNT_DIGITS = 10;
export const MAX_ACCOUNT_DIGITS = 15;

/** Display name for a stored code, falling back to the code itself. */
export function bankDisplayName(code: string | null | undefined): string {
  if (!code) return '—';
  return THAI_BANKS.find((bank) => bank.code === code)?.name ?? code;
}
