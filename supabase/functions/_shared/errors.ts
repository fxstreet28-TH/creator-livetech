import { corsHeaders } from './cors.ts';

export type ErrorCode =
  | 'invalid_input'
  | 'invalid_credentials'
  | 'invalid_otp'
  | 'otp_expired'
  | 'rate_limited'
  | 'not_found'
  | 'internal_error';

interface ErrorMap {
  status: number;
  message_th: string;
}

const ERROR_MAP: Record<ErrorCode, ErrorMap> = {
  invalid_input: { status: 400, message_th: 'ข้อมูลไม่ถูกต้อง' },
  invalid_credentials: { status: 401, message_th: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' },
  invalid_otp: { status: 400, message_th: 'รหัสยืนยันไม่ถูกต้อง' },
  otp_expired: { status: 400, message_th: 'รหัสยืนยันหมดอายุ' },
  rate_limited: { status: 429, message_th: 'คำขอมากเกินไป กรุณารอสักครู่' },
  not_found: { status: 404, message_th: 'ไม่พบข้อมูล' },
  internal_error: { status: 500, message_th: 'เกิดข้อผิดพลาด กรุณาลองใหม่' },
};

export function errorResponse(code: ErrorCode, origin: string | null, detail?: string): Response {
  const { status, message_th } = ERROR_MAP[code];
  return new Response(
    JSON.stringify({ error: code, message: message_th, detail: detail ?? null }),
    {
      status,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    },
  );
}

export function successResponse<T>(body: T, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}
