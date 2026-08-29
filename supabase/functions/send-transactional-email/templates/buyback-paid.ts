/**
 * "Funds dispatched" — sent when a buyback moves to 'paid'.
 *
 * The payout is a manual bank transfer, so this email does double duty: it
 * confirms the transfer and it shows the customer which account the money
 * went to, which is the only way they can catch a wrong account before the
 * money is gone.
 */

import {
  aurumStar,
  brandHeader,
  detailRow,
  emailFooter,
  emailWrapper,
  FONT_MONO,
  FONT_SANS,
  FONT_SERIF,
  ornamentDivider,
} from '../lib/base.ts';
import {
  addDays,
  bankLabel,
  escapeHtml,
  formatBangkokDate,
  formatBangkokDateTime,
  formatBangkokDateUppercase,
  formatShortRef,
  formatThb,
} from '../lib/format.ts';
import type { RenderedEmail } from './purchase.ts';

export interface BuybackPaidRow {
  id: string;
  star_amount: number;
  total_thb: string | number;
  thb_per_star: string | number;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_name: string | null;
  processed_at: string | null;
}

export function renderBuybackPaid(input: { buyback: BuybackPaidRow }): RenderedEmail {
  const { buyback } = input;

  const stars = buyback.star_amount;
  const totalThb = formatThb(buyback.total_thb);
  const rate = formatThb(buyback.thb_per_star);
  const bank = bankLabel(buyback.bank_name ?? '');
  const account = buyback.bank_account_number ?? '';
  const holder = buyback.bank_account_name ?? '';
  const ref = formatShortRef('BB', buyback.id);
  // admin_transition_buyback_status stamps processed_at on the move to
  // 'paid'; the fallback only matters for a hand-written UPDATE.
  const processedAt = buyback.processed_at ?? new Date().toISOString();
  const dateFull = formatBangkokDateTime(processedAt);
  const dateHeader = formatBangkokDateUppercase(processedAt);
  // Satang are set smaller than baht, so the figure splits at the point.
  const [thbInt, thbDec] = totalThb.split('.');
  const deadline = formatBangkokDate(addDays(processedAt, 2));

  const subject = `AURUM · โอนเงินขายดาว ฿${totalThb} เข้าบัญชีแล้ว`;

  const inner = `
${brandHeader(dateHeader)}

<table role="presentation" width="540" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;margin:0 auto;background:#ffffff;border-radius:14px;box-shadow:0 1px 2px rgba(74,55,20,0.04),0 12px 32px rgba(74,55,20,0.06);">
  <tr>
    <td style="height:3px;background:linear-gradient(90deg,#6B8E5A,#A8C58F,#6B8E5A);border-top-left-radius:14px;border-top-right-radius:14px;font-size:0;line-height:0;">&nbsp;</td>
  </tr>
  <tr>
    <td class="card-inner" align="center" style="padding:44px 40px 28px;font-family:${FONT_SANS};">
      <div style="width:68px;height:68px;margin:0 auto 24px;border-radius:50%;background:#F0F5EA;border:1px solid #DFE9D2;line-height:66px;text-align:center;">
        ${aurumStar(34)}
      </div>
      <div style="font-family:${FONT_SANS};font-size:10px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:#4E7A3F;margin:0 0 16px;">Funds Dispatched</div>
      <div style="font-family:${FONT_SERIF};font-size:60px;font-weight:400;color:#1a1614;line-height:1;letter-spacing:-0.6px;margin:0 0 12px;">฿${thbInt}<span style="font-size:36px;color:#8a8579;font-weight:300;">.${thbDec}</span></div>
      <div style="font-family:${FONT_SANS};font-size:13px;color:#57534e;margin:0;">
        โอนเงินขายดาวเข้าบัญชีเรียบร้อย
        <div style="margin-top:2px;font-size:12px;color:#8a8579;font-style:italic;">Transferred to your bank account</div>
      </div>
    </td>
  </tr>
  <tr>
    <td>${ornamentDivider('#6B8E5A')}</td>
  </tr>
  <tr>
    <td class="card-inner" style="padding:16px 40px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(135deg,#F5F0E1,#EFE7D0);border:1px solid #EDE3C4;border-radius:12px;">
        <tr>
          <td align="center" style="padding:28px 24px;">
            <div style="font-family:${FONT_SANS};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a8579;margin:0 0 14px;font-weight:500;">Deposited To</div>
            <div style="font-family:${FONT_SERIF};font-size:26px;font-weight:500;color:#1a1614;margin:0 0 8px;">${escapeHtml(bank)}</div>
            <div style="font-family:${FONT_MONO};font-size:16px;color:#57534e;letter-spacing:3.2px;margin:0 0 8px;font-weight:500;">${escapeHtml(account)}</div>
            <div style="width:32px;height:1px;background:#C9A961;margin:12px auto;opacity:0.5;font-size:0;line-height:0;">&nbsp;</div>
            <div style="font-family:${FONT_SERIF};font-size:13px;color:#57534e;font-style:italic;font-weight:500;">${escapeHtml(holder)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td class="card-inner" style="padding:8px 40px 20px;font-family:${FONT_SANS};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${detailRow('Stars Redeemed', `${stars} stars`)}
        ${detailRow('Buyback Rate', `฿${rate} per star`)}
        ${detailRow('Total Amount', `฿${totalThb} THB`)}
        ${detailRow('Reference', ref, 'mono')}
        ${detailRow('Processed', dateFull)}
        ${detailRow('Authorised By', 'AURUM Operations', 'plain', true)}
      </table>
    </td>
  </tr>
  <tr>
    <td class="card-inner" style="padding:0 40px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8FBF4;border:1px solid #E4EFD8;border-radius:10px;">
        <tr>
          <td style="padding:20px 24px;font-family:${FONT_SANS};">
            <div style="margin-bottom:6px;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#6B8E5A;vertical-align:middle;margin-right:10px;"></span>
              <span style="font-size:13px;font-weight:600;color:#1a1614;vertical-align:middle;">เงินจะเข้าบัญชีภายใน 1 วันทำการ</span>
            </div>
            <div style="font-size:12px;color:#57534e;padding-left:18px;line-height:1.6;">
              Funds are typically received within 1 business day. If you don't see the deposit by ${deadline}, please contact support.
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>

${emailFooter()}`;

  const text = `AURUM · Funds Dispatched

฿${totalThb} transferred to your bank.

Deposited To:    ${bank}
Account Number:  ${account}
Account Holder:  ${holder}

Stars Redeemed:  ${stars} stars
Buyback Rate:    ฿${rate} per star
Total Amount:    ฿${totalThb} THB
Reference:       ${ref}
Processed:       ${dateFull}

Funds typically arrive within 1 business day.
If not received by ${deadline}, contact support.

—
AURUM · Creator LiveTech
support@creatorlivetech.com`;

  return { subject, html: emailWrapper(inner), text };
}
