import { fail, ok, safeServerError } from "@/lib/api-response";
import { verifyOtpHash } from "@/lib/otp";
import { signupConfig } from "@/lib/server-config";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { challengeId, code } = (await request.json()) as { challengeId?: string; code?: string };
    if (!challengeId || !/^\d{6}$/.test(code || "")) return fail("กรุณากรอกรหัส 6 หลัก");
    const db = supabaseAdmin();
    const { data, error } = await db.from("signup_challenges").select("*").eq("id", challengeId).single();
    if (error || !data || data.completed_at) return fail("ไม่พบคำขอสมัครสมาชิก", 404);
    if (new Date(data.expires_at).getTime() < Date.now()) return fail("รหัสหมดอายุ กรุณาเริ่มใหม่", 410);
    if (data.email_verified_at) return ok({ verified: true });
    if (data.email_attempts >= signupConfig.maxAttempts) return fail("กรอกรหัสผิดเกินจำนวนที่กำหนด กรุณาเริ่มใหม่", 429);

    const valid = verifyOtpHash(challengeId, code!, data.email_code_hash);
    const nextAttempts = data.email_attempts + 1;
    const { error: updateError } = await db.from("signup_challenges").update({
      email_attempts: nextAttempts,
      ...(valid ? { email_verified_at: new Date().toISOString() } : {}),
    }).eq("id", challengeId);
    if (updateError) throw updateError;
    if (!valid) return fail(`รหัสไม่ถูกต้อง เหลือ ${signupConfig.maxAttempts - nextAttempts} ครั้ง`);
    return ok({ verified: true });
  } catch (error) {
    return safeServerError(error);
  }
}
