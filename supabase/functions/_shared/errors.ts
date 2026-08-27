import { corsHeaders } from './cors.ts';

export type ErrorCode =
  | 'invalid_input'
  | 'invalid_credentials'
  | 'invalid_otp'
  | 'otp_expired'
  | 'rate_limited'
  | 'forbidden'
  | 'not_found'
  | 'internal_error'
  // Week 3 — star purchase (create-payment-intent)
  | 'invalid_amount'
  | 'not_customer'
  | 'no_active_pricing'
  | 'wallet_cap_exceeded'
  | 'stripe_error'
  // Week 3 — buyback (buyback-request)
  | 'below_minimum'
  | 'insufficient_stars'
  | 'missing_bank_info'
  | 'invalid_account_number'
  | 'wallet_not_found';

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
  forbidden: { status: 403, message_th: 'ไม่มีสิทธิ์เข้าถึง' },
  not_found: { status: 404, message_th: 'ไม่พบข้อมูล' },
  internal_error: { status: 500, message_th: 'เกิดข้อผิดพลาด กรุณาลองใหม่' },

  // Star purchase. no_active_pricing is a 503 and not a 500 on purpose:
  // there is no live row in star_pricing_config, which is a configuration
  // gap the operator can close in one UPDATE, and the buy screen should
  // invite a retry rather than report a crash. stripe_error is a 502 for
  // the same reason — the failure is upstream, not here.
  invalid_amount: { status: 400, message_th: 'จำนวน stars ต้องอยู่ระหว่าง 10-100,000' },
  not_customer: { status: 403, message_th: 'บัญชีผู้ใช้ยังไม่พร้อมสำหรับการซื้อ' },
  no_active_pricing: { status: 503, message_th: 'ระบบราคาไม่พร้อมใช้งาน กรุณาลองใหม่' },
  wallet_cap_exceeded: { status: 400, message_th: 'ยอด stars ในกระเป๋าจะเกินขีดจำกัด' },
  stripe_error: { status: 502, message_th: 'ไม่สามารถสร้างรายการชำระเงินได้' },

  // Buyback.
  below_minimum: { status: 400, message_th: 'ต้องขาย buyback อย่างน้อย 10 stars' },
  insufficient_stars: { status: 400, message_th: 'จำนวน stars ไม่พอ' },
  missing_bank_info: { status: 400, message_th: 'กรุณากรอกข้อมูลธนาคารให้ครบ' },
  invalid_account_number: { status: 400, message_th: 'เลขที่บัญชีธนาคารไม่ถูกต้อง' },
  wallet_not_found: { status: 404, message_th: 'ไม่พบ wallet' },
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
