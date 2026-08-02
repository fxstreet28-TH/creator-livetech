import { fail, ok, safeServerError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { challengeId } = (await request.json()) as { challengeId?: string };
    if (!challengeId) return fail("ข้อมูลคำขอไม่ครบ");
    const { data, error } = await supabaseAdmin().rpc("complete_signup", {
      challenge_uuid: challengeId,
    });
    if (error) return fail(error.message.includes("not verified") ? "กรุณายืนยัน Email และเบอร์ให้ครบ" : "ไม่สามารถสร้างบัญชีได้", 409);
    return ok({ accountId: data });
  } catch (error) {
    return safeServerError(error);
  }
}
