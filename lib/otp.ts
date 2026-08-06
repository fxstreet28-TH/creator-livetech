import crypto from 'node:crypto';

export function generateOtp(length = 6): string {
  const digits = '0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += digits[crypto.randomInt(0, 10)];
  }
  return out;
}

export function hashOtp(code: string): string {
  const secret = process.env.OTP_HMAC_SECRET;
  if (!secret) throw new Error('OTP_HMAC_SECRET not set');
  return crypto.createHmac('sha256', secret).update(code).digest('hex');
}

export function verifyOtp(code: string, hash: string): boolean {
  const computed = hashOtp(code);
  const a = Buffer.from(computed);
  const b = Buffer.from(hash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// AES-256-GCM for password encryption in signup_sessions.
// The key is a 32-byte value provided as 64 hex chars in SESSION_ENCRYPTION_KEY.
export function encryptPassword(plaintext: string): string {
  const key = Buffer.from(requireKey(), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptPassword(payload: string): string {
  const key = Buffer.from(requireKey(), 'hex');
  const [ivHex, tagHex, ctHex] = payload.split(':');
  if (!ivHex || !tagHex || !ctHex) throw new Error('Malformed encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function requireKey(): string {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  if (!key) throw new Error('SESSION_ENCRYPTION_KEY not set');
  if (key.length !== 64) {
    throw new Error('SESSION_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  return key;
}
