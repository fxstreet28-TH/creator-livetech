import { NextResponse } from "next/server";

export function ok(data: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...data });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, message }, { status });
}

export function safeServerError(error: unknown) {
  console.error(error);
  return fail("ระบบขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง", 500);
}
