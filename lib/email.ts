import 'server-only';
import { Resend } from 'resend';

interface SendEmailCodeInput {
  to: string;
  code: string;
}

type SendEmailResult =
  | { ok: true; id?: string }
  | { ok: false; error: string };

export async function sendEmailVerificationCode(
  input: SendEmailCodeInput,
): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;

  if (!apiKey) {
    console.error('[resend] RESEND_API_KEY not set');
    return { ok: false, error: 'email_provider_misconfigured' };
  }
  if (!fromEmail) {
    console.error('[resend] RESEND_FROM_EMAIL not set');
    return { ok: false, error: 'email_provider_misconfigured' };
  }

  const resend = new Resend(apiKey);

  try {
    const result = await resend.emails.send({
      from: fromEmail,
      to: input.to,
      subject: `รหัสยืนยันอีเมล AURUM Live: ${input.code}`,
      html: renderEmailCodeTemplate(input.code),
    });
    if (result.error) {
      console.error('[resend] send failed', result.error);
      return { ok: false, error: 'email_send_failed' };
    }
    return { ok: true, id: result.data?.id };
  } catch (err) {
    console.error('[resend] exception', err);
    return { ok: false, error: 'email_provider_exception' };
  }
}

function renderEmailCodeTemplate(code: string): string {
  return `<!doctype html>
<html lang="th">
<head><meta charset="utf-8"><title>ยืนยันอีเมล AURUM Live</title></head>
<body style="margin:0;padding:0;background:#0a0a15;font-family:'Noto Sans Thai', 'Inter', sans-serif;color:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a15;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#14142b;border-radius:16px;padding:40px;border:1px solid rgba(255,255,255,0.08);">
        <tr><td align="center" style="padding-bottom:24px;">
          <div style="font-size:24px;font-weight:700;background:linear-gradient(90deg,#8b5cf6,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">AURUM Live</div>
        </td></tr>
        <tr><td style="font-size:20px;font-weight:600;color:#ffffff;padding-bottom:12px;">รหัสยืนยันอีเมลของคุณ</td></tr>
        <tr><td style="font-size:14px;color:#a1a1aa;padding-bottom:24px;line-height:1.6;">กรุณาใส่รหัส 6 หลักด้านล่างในหน้าสมัครสมาชิก เพื่อยืนยันอีเมลของคุณ รหัสจะหมดอายุใน 10 นาที</td></tr>
        <tr><td align="center" style="padding:16px 0;">
          <div style="font-size:36px;font-weight:700;letter-spacing:12px;background:linear-gradient(90deg,#8b5cf6,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">${code}</div>
        </td></tr>
        <tr><td style="font-size:12px;color:#71717a;padding-top:24px;line-height:1.6;">หากคุณไม่ได้ทำการสมัครสมาชิก กรุณาละเลยอีเมลฉบับนี้ อย่าเปิดเผยรหัสนี้ให้ผู้อื่น</td></tr>
      </table>
      <div style="font-size:11px;color:#52525b;padding-top:24px;">© 2026 AURUM TECH · creatorlivetech.com</div>
    </td></tr>
  </table>
</body>
</html>`;
}
