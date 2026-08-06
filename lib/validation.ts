/**
 * Shared validation helpers used on both the client (inline errors) and the
 * server (authoritative gate). Keep these framework-free so they import cleanly
 * into client components and route handlers alike.
 */

// Practical RFC 5322 subset: one @, no spaces, a dotted domain, sane length.
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  return EMAIL_RE.test(email);
}

export type PasswordCheck = { ok: boolean; reason?: 'too_short' | 'need_letter' | 'need_number' };

export function validatePassword(pw: string): PasswordCheck {
  if (!pw || pw.length < 8) return { ok: false, reason: 'too_short' };
  if (!/[A-Za-z]/.test(pw)) return { ok: false, reason: 'need_letter' };
  if (!/[0-9]/.test(pw)) return { ok: false, reason: 'need_number' };
  return { ok: true };
}

/** 0-3 strength score for the inline strength meter. */
export function passwordStrength(pw: string): number {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) score++;
  if (pw.length >= 12 && /[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}
