import { fail, ok, safeServerError } from "@/lib/api-response";
import { verifySmsOtp } from "@/lib/movider";
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
    if (data.phone_verified_at) return ok({ verified: true });
    if (data.phone_attempts >= signupConfig.maxAttempts) return fail("กรอกรหัสผิดเกินจำนวนที่กำหนด กรุณาเริ่มใหม่", 429);
    if (!data.movider_request_id) return fail("ระบบ SMS ยังไม่พร้อม กรุณาเริ่มใหม่", 409);

    const nextAttempts = data.phone_attempts + 1;
    try {
      await verifySmsOtp(data.movider_request_id, code!);
    } catch {
      await db.from("signup_challenges").update({ phone_attempts: nextAttempts }).eq("id", challengeId);
      return fail(`รหัสไม่ถูกต้อง เหลือ ${signupConfig.maxAttempts - nextAttempts} ครั้ง`);
    }
    const { error: updateError } = await db.from("signup_challenges").update({
      phone_attempts: nextAttempts,
      phone_verified_at: new Date().toISOString(),
    }).eq("id", challengeId);
    if (updateError) throw updateError;
    return ok({ verified: true });
  } catch (error) {
    return safeServerError(error);
  }
}
