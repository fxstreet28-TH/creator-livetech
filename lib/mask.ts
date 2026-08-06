/**
 * Masking helpers for surfacing where codes were sent without leaking the full
 * phone/email back to the client.
 */

// e.g. "+66812345678" → "+66 8X-XXX-5678"
export function maskPhone(e164: string): string {
  const rest = e164.startsWith('+66') ? e164.slice(3) : e164.replace(/^\+/, '');
  if (rest.length < 5) return e164;
  return `+66 ${rest[0]}X-XXX-${rest.slice(-4)}`;
}

// e.g. "por@aurumtech.com" → "p***@aurumtech.com"
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local[0] ?? '';
  return `${visible}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}
