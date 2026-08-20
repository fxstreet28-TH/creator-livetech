/**
 * OTP hashing/verification and signup-session password crypto.
 * Deno port of lib/otp.ts.
 *
 * Uses Web Crypto — do NOT import node:crypto in Edge Functions even though
 * Deno technically allows it. Supabase's Deno runtime disables Node built-ins
 * for security.
 *
 * The contract must match lib/otp.ts EXACTLY so hashes already stored in
 * phone_otps.code_hash / email_codes.code_hash stay verifiable, and so
 * signup_sessions rows written by the Next.js routes stay decryptable.
 *
 * Note this is HMAC-SHA256 keyed on OTP_HMAC_SECRET — NOT a plain salted
 * SHA-256 digest. Node's `createHmac('sha256', secret)` treats a string key as
 * its UTF-8 bytes, which is what `TextEncoder().encode(secret)` produces here.
 */

const encoder = new TextEncoder();

/** UTF-8 bytes backed by a concrete ArrayBuffer, so they satisfy BufferSource. */
function utf8(text: string) {
  const src = encoder.encode(text);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

function requireSecret(): string {
  const secret = Deno.env.get('OTP_HMAC_SECRET');
  if (!secret) throw new Error('OTP_HMAC_SECRET not set');
  return secret;
}

/** Cryptographically secure 6-digit code. Port of lib/otp.ts generateOtp. */
export function generateOtp(length = 6): string {
  const digits = '0123456789';
  const bytes = new Uint8Array(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    // Rejection sampling keeps the digits uniform — 256 is not a multiple of 10,
    // so naively taking `byte % 10` would bias 0-5.
    let value: number;
    do {
      crypto.getRandomValues(bytes.subarray(i, i + 1));
      value = bytes[i];
    } while (value >= 250);
    out += digits[value % 10];
  }
  return out;
}

export async function hashOtp(code: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(requireSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8(code));
  return toHex(new Uint8Array(sig));
}

/**
 * Constant-time comparison. Web Crypto has no timingSafeEqual — we roll our
 * own. Do NOT use === on hashes.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyOtp(code: string, hash: string): Promise<boolean> {
  return safeEqual(await hashOtp(code), hash);
}

// AES-256-GCM for password encryption in signup_sessions.
// The key is a 32-byte value provided as 64 hex chars in SESSION_ENCRYPTION_KEY.
// Wire format is `iv:tag:ciphertext` (all hex) — identical to lib/otp.ts.
// Web Crypto appends the 16-byte auth tag to the ciphertext, whereas Node
// exposes it separately, so we split it off on encrypt and re-join on decrypt.
const TAG_BYTES = 16;

export async function encryptPassword(plaintext: string): Promise<string> {
  const key = await importAesKey(['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(plaintext)),
  );
  const ct = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  return `${toHex(iv)}:${toHex(tag)}:${toHex(ct)}`;
}

export async function decryptPassword(payload: string): Promise<string> {
  const [ivHex, tagHex, ctHex] = payload.split(':');
  if (!ivHex || !tagHex || !ctHex) throw new Error('Malformed encrypted payload');

  const key = await importAesKey(['decrypt']);
  const ct = fromHex(ctHex);
  const tag = fromHex(tagHex);
  const sealed = new Uint8Array(new ArrayBuffer(ct.length + tag.length));
  sealed.set(ct);
  sealed.set(tag, ct.length);

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromHex(ivHex) },
    key,
    sealed,
  );
  return new TextDecoder().decode(plain);
}

function importAesKey(usages: KeyUsage[]): Promise<CryptoKey> {
  const key = Deno.env.get('SESSION_ENCRYPTION_KEY');
  if (!key) throw new Error('SESSION_ENCRYPTION_KEY not set');
  if (key.length !== 64) {
    throw new Error('SESSION_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  return crypto.subtle.importKey('raw', fromHex(key), { name: 'AES-GCM' }, false, usages);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// Backed by a concrete ArrayBuffer (not the default ArrayBufferLike) so the
// result satisfies BufferSource under strict type-checking.
function fromHex(hex: string) {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
