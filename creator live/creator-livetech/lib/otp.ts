import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { requiredEnv } from "./server-config";

export function createOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashOtp(challengeId: string, code: string): string {
  return createHmac("sha256", requiredEnv("OTP_PEPPER"))
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

export function verifyOtpHash(
  challengeId: string,
  code: string,
  expected: string,
): boolean {
  const actual = hashOtp(challengeId, code);
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeThaiPhone(value: string): string | null {
  const digits = value.replace(/[^\d+]/g, "");
  if (/^0\d{9}$/.test(digits)) return `66${digits.slice(1)}`;
  if (/^\+66\d{9}$/.test(digits)) return digits.slice(1);
  if (/^66\d{9}$/.test(digits)) return digits;
  return null;
}
