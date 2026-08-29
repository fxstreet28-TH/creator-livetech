/**
 * "Stars credited" — sent once, when a purchase reaches 'succeeded'.
 *
 * The number of stars is the headline because that is what the buyer was
 * shopping for; the baht they paid is a detail row underneath it.
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
  paymentMethodLabel,
} from '../lib/format.ts';

export interface PurchaseRow {
  id: string;
  stars_amount: number;
  thb_amount: string | number;
  payment_method: string;
  completed_at: string | null;
  expires_at: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderPurchase(input: {
  purchase: PurchaseRow;
  walletBalance: number;
}): RenderedEmail {
  const { purchase, walletBalance } = input;

  const stars = purchase.stars_amount;
  const thb = formatThb(purchase.thb_amount);
  const method = escapeHtml(paymentMethodLabel(purchase.payment_method));
  const ref = formatShortRef('PAY', purchase.id);
  // completed_at is set in the same statement that writes 'succeeded', but
  // fall back rather than render "Invalid Date" if it ever is not.
  const completedAt = purchase.completed_at ?? new Date().toISOString();
  const dateFull = formatBangkokDateTime(completedAt);
  const dateHeader = formatBangkokDateUppercase(completedAt);
  const expires = formatBangkokDate(purchase.expires_at);

  const subject = `AURUM · เติมดาว ${stars} ดวงสำเร็จ`;

  const inner = `
${brandHeader(dateHeader)}

<table role="presentation" width="540" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;margin:0 auto;background:#ffffff;border-radius:14px;box-shadow:0 1px 2px rgba(74,55,20,0.04),0 12px 32px rgba(74,55,20,0.06);">
  <tr>
    <td style="height:3px;background:linear-gradient(90deg,#C9A961,#E8CE85,#C9A961);border-top-left-radius:14px;border-top-right-radius:14px;font-size:0;line-height:0;">&nbsp;</td>
  </tr>
  <tr>
    <td class="card-inner" align="center" style="padding:44px 40px 28px;font-family:${FONT_SANS};">
      <div style="width:68px;height:68px;margin:0 auto 24px;border-radius:50%;background:#FBF6E8;border:1px solid #F0E7CB;line-height:66px;text-align:center;">
        ${aurumStar(34)}
      </div>
      <div style="font-family:${FONT_SANS};font-size:10px;font-weight:600;letter-spacing:2.8px;text-transform:uppercase;color:#A47E1B;margin:0 0 16px;">Stars Credited</div>
      <div style="font-family:${FONT_SERIF};font-size:52px;font-weight:400;color:#1a1614;line-height:1;letter-spacing:-0.5px;margin:0 0 12px;">${stars}<span style="font-size:22px;color:#8a8579;margin-left:6px;font-weight:300;font-style:italic;">stars</span></div>
      <div style="font-family:${FONT_SANS};font-size:13px;color:#57534e;margin:0;">
        เติมดาวเข้ากระเป๋าเรียบร้อย
        <div style="margin-top:2px;font-size:12px;color:#8a8579;font-style:italic;">Added to your wallet</div>
      </div>
    </td>
  </tr>
  <tr>
    <td>${ornamentDivider('#C9A961')}</td>
  </tr>
  <tr>
    <td class="card-inner" style="padding:8px 40px 20px;font-family:${FONT_SANS};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${detailRow('Amount Paid', `฿${thb}`, 'serif')}
        ${detailRow('Payment Method', method)}
        ${detailRow('Reference', ref, 'mono')}
        ${detailRow('Date', dateFull, 'plain', true)}
      </table>
    </td>
  </tr>
  <tr>
    <td class="card-inner" style="padding:0 40px 24px;">
      ${balancePanel('Wallet Balance', walletBalance, expires)}
    </td>
  </tr>
</table>

${emailFooter()}`;

  const text = `AURUM · Stars Credited

${stars} stars added to your wallet.

Amount Paid:    ฿${thb}
Payment Method: ${paymentMethodLabel(purchase.payment_method)}
Reference:      ${ref}
Date:           ${dateFull}

Wallet Balance: ${walletBalance} stars (valid until ${expires})

—
AURUM · Creator LiveTech
support@creatorlivetech.com`;

  return { subject, html: emailWrapper(inner), text };
}
