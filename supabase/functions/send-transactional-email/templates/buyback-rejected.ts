/**
 * "Buyback cancelled · stars refunded" — sent when a buyback moves to
 * 'rejected'.
 *
 * The stars are already back in the wallet by the time this sends:
 * admin_refund_buyback credits a fresh star_purchases batch and only then
 * flips the status that fires the trigger. So this reads as a completed
 * refund, not a pending one, and the expiry shown is the new batch's own
 * six-month clock rather than the original purchase's.
 *
 * The rejection reason is quoted verbatim because it is the only thing in
 * the email that answers "why". It is typed by an operator in the CRM and
 * escaped on the way in.
 */

import {
  aurumStar,
  balancePanel,
  brandHeader,
  detailRow,
  emailFooter,
  emailWrapper,
  FONT_SANS,
  FONT_SERIF,
  ornamentDivider,
} from '../lib/base.ts';
import {
  escapeHtml,
  formatBangkokDate,
  formatBangkokDateTime,
  formatBangkokDateUppercase,
  formatShortRef,
  formatThb,
} from '../lib/format.ts';
import type { RenderedEmail } from './purchase.ts';

export interface BuybackRejectedRow {
  id: string;
  star_amount: number;
  total_thb: string | number;
  rejection_reason: string | null;
  processed_at: string | null;
}

export function renderBuybackRejected(input: {
  buyback: BuybackRejectedRow;
  refundExpiresAt: string;
}): RenderedEmail {
  const { buyback, refundExpiresAt } = input;

  const stars = buyback.star_amount;
  const totalThb = formatThb(buyback.total_thb);
  const reason = buyback.rejection_reason ?? '';
  const ref = formatShortRef('BB', buyback.id);
  const processedAt = buyback.processed_at ?? new Date().toISOString();
  const dateFull = formatBangkokDateTime(processedAt);
  const dateHeader = formatBangkokDateUppercase(processedAt);
  const refundExpiry = formatBangkokDate(refundExpiresAt);

  const subject = `AURUM · ยกเลิกการขายดาว ${stars} ดวง · คืนดาวเข้ากระเป๋าแล้ว`;

  const inner = `
${brandHeader(dateHeader)}

<table role="presentation" width="540" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;margin:0 auto;background:#ffffff;border-radius:14px;box-shadow:0 1px 2px rgba(74,55,20,0.04),0 12px 32px rgba(74,55,20,0.06);">
  <tr>
    <td style="height:3px;background:linear-gradient(90deg,#B48A55,#D9B87F,#B48A55);border-top-left-radius:14px;border-top-right-radius:14px;font-size:0;line-height:0;">&nbsp;</td>
  </tr>
  <tr>
    <td class="card-inner" align="center" style="padding:44px 40px 28px;font-family:${FONT_SANS};">
      <div style="width:68px;height:68px;margin:0 auto 24px;border-radius:50%;background:#F9F1E4;border:1px solid #EEDFC3;line-height:66px;text-align:center;">
        ${aurumStar(34)}
      </div>
      <div style="font-family:${FONT_SANS};font-size:10px;font-weight:600;letter-spacing:2.8px;text-transform:uppercase;color:#8B5A2B;margin:0 0 16px;">Buyback Cancelled · Stars Refunded</div>
      <div style="font-family:${FONT_SERIF};font-size:52px;font-weight:400;color:#1a1614;line-height:1;letter-spacing:-0.5px;margin:0 0 12px;">${stars}<span style="font-size:22px;color:#8a8579;margin-left:6px;font-weight:300;font-style:italic;">stars</span></div>
      <div style="font-family:${FONT_SANS};font-size:13px;color:#57534e;margin:0;">
        คืนดาวเข้ากระเป๋าเรียบร้อย
        <div style="margin-top:2px;font-size:12px;color:#8a8579;font-style:italic;">Returned to your wallet</div>
      </div>
    </td>
  </tr>
  <tr>
    <td>${ornamentDivider('#B48A55')}</td>
  </tr>
  <tr>
    <td class="card-inner" style="padding:8px 40px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBF6E8;border-left:3px solid #C9A961;border-radius:10px;">
        <tr>
          <td style="padding:22px 26px;">
            <div style="font-family:${FONT_SANS};font-size:10px;font-weight:500;letter-spacing:2.4px;text-transform:uppercase;color:#8a8579;margin:0 0 10px;">Reason for Cancellation</div>
            <div style="font-family:${FONT_SERIF};font-size:18px;font-style:italic;font-weight:400;color:#1a1614;line-height:1.5;">&ldquo;${escapeHtml(reason)}&rdquo;</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td class="card-inner" style="padding:0 40px 20px;font-family:${FONT_SANS};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${detailRow('Original Amount', `฿${totalThb}`)}
        ${detailRow('Reference', ref, 'mono')}
        ${detailRow('Processed', dateFull, 'plain', true)}
      </table>
    </td>
  </tr>
  <tr>
    <td class="card-inner" style="padding:0 40px 24px;">
      ${balancePanel('Stars Returned', stars, refundExpiry)}
    </td>
  </tr>
</table>

${emailFooter()}`;

  const text = `AURUM · Buyback Cancelled · Stars Refunded

${stars} stars returned to your wallet.

Original Amount:  ฿${totalThb}
Reference:        ${ref}
Processed:        ${dateFull}

Reason for Cancellation:
"${reason}"

Stars Returned:   ${stars} stars (valid until ${refundExpiry})

Refunded stars behave like a normal purchase and can be spent or resold.
For questions, contact support.

—
AURUM · Creator LiveTech
support@creatorlivetech.com`;

  return { subject, html: emailWrapper(inner), text };
}
