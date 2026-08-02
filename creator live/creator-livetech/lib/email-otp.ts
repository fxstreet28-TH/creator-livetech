import { Resend } from "resend";
import { requiredEnv } from "./server-config";

export async function sendEmailOtp(to: string, code: string) {
  const resend = new Resend(requiredEnv("RESEND_API_KEY"));
  const { error } = await resend.emails.send({
    from: requiredEnv("RESEND_FROM_EMAIL"),
    to,
    subject: "รหัสยืนยัน Creator LiveTech",
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:28px"><h2>ยืนยันอีเมล Creator LiveTech</h2><p>รหัสยืนยันของคุณคือ</p><div style="font-size:34px;font-weight:800;letter-spacing:8px;padding:18px 0">${code}</div><p>รหัสนี้มีอายุ 5 นาที หากคุณไม่ได้สมัครสมาชิก กรุณาไม่ต้องดำเนินการใด ๆ</p></div>`,
  });
  if (error) throw new Error(error.message);
}
