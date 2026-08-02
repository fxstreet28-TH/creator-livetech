export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const signupConfig = {
  otpTtlSeconds: 300,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
};
