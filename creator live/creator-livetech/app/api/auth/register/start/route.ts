import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { fail, ok, safeServerError } from "@/lib/api-response";
import { sendEmailOtp } from "@/lib/email-otp";
import { requestSmsOtp } from "@/lib/movider";
import { createOtp, hashOtp, normalizeEmail, normalizeThaiPhone } from "@/lib/otp";
import { signupConfig } from "@/lib/server-config";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const fullName = String(body.fullName || "").trim();
    const email = normalizeEmail(String(body.email || ""));
    const phone = normalizeThaiPhone(String(body.phone || ""));
    const password = String(body.password || "");

    if (fullName.length < 2 || fullName.length > 100) return fail("กรุณากรอกชื่อให้ถูกต้อง");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("รูปแบบอีเมลไม่ถูกต้อง");
    if (!phone) return fail("กรุณากรอกเบอร์ไทย เช่น 0812345678");
    if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return fail("รหัสผ่านต้องมีอย่างน้อย 10 ตัว และประกอบด้วยตัวอักษรกับตัวเลข");
    }

    const db = supabaseAdmin();
    const { data: existingEmail } = await db
      .from("user_accounts")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    const { data: existingPhone } = await db
      .from("user_accounts")
      .select("id")
      .eq("phone", phone)
      .maybeSingle();
    if (existingEmail || existingPhone) return fail("อีเมลหรือเบอร์นี้มีบัญชีแล้ว", 409);

    await db.from("signup_challenges").delete().lt("expires_at", new Date().toISOString());
    const id = randomUUID();
    const emailCode = createOtp();
    const expiresAt = new Date(Date.now() + signupConfig.otpTtlSeconds * 1000).toISOString();
    const passwordHash = await bcrypt.hash(password, 12);

    const { error: insertError } = await db.from("signup_challenges").insert({
      id,
      full_name: fullName,
      email,
      phone,
      password_hash: passwordHash,
      email_code_hash: hashOtp(id, emailCode),
      expires_at: expiresAt,
    });
    if (insertError?.code === "23505") return fail("มีคำขอยืนยันของอีเมลหรือเบอร์นี้อยู่แล้ว กรุณารอ 5 นาที", 429);
    if (insertError) throw insertError;

    try {
      const [moviderRequestId] = await Promise.all([
        requestSmsOtp(phone),
        sendEmailOtp(email, emailCode),
      ]);
      const { error } = await db
        .from("signup_challenges")
        .update({ movider_request_id: moviderRequestId })
        .eq("id", id);
      if (error) throw error;
    } catch (deliveryError) {
      await db.from("signup_challenges").delete().eq("id", id);
      throw deliveryError;
    }

    return ok({ challengeId: id, expiresIn: signupConfig.otpTtlSeconds });
  } catch (error) {
    return safeServerError(error);
  }
}
