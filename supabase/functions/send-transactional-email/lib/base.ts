/**
 * The chrome every transactional email shares: wrapper, header, footer,
 * divider, and the AURUM star.
 *
 * Written for mail clients, not browsers. That means table layout, inline
 * styles on every element, no external stylesheet the body depends on,
 * and no flexbox or grid. Outlook's Word renderer ignores most of what a
 * normal page would use.
 *
 * The star is inline SVG rather than a hosted image on purpose: images are
 * blocked by default in most clients, and a receipt whose only branding is
 * a broken image placeholder reads as a phishing attempt.
 */

/**
 * Gradient ids are suffixed with the size so two stars at different sizes
 * in one document do not collide on `id` and inherit the wrong fill.
 */
export const aurumStar = (size: number, opacity = 1): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;opacity:${opacity}"><defs><linearGradient id="s${size}" x1="15%" y1="10%" x2="85%" y2="95%"><stop offset="0%" stop-color="#F5B8FF"/><stop offset="30%" stop-color="#C8B4FD"/><stop offset="60%" stop-color="#8FB8F5"/><stop offset="100%" stop-color="#5D5FE8"/></linearGradient></defs><path d="M50 5 L61.5 38.5 L97 38.5 L68.5 59.5 L79.5 93 L50 72 L20.5 93 L31.5 59.5 L3 38.5 L38.5 38.5 Z" fill="url(#s${size})"/></svg>`;

// Each stack ends in a family the client is certain to have. The webfont
// link in the wrapper is a progressive enhancement; Gmail's web client
// honours it, most others do not.
export const FONT_SERIF = `'Cormorant Garamond', Georgia, 'Times New Roman', serif`;
export const FONT_SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans Thai', Roboto, sans-serif`;
export const FONT_MONO = `'JetBrains Mono', 'Courier New', monospace`;

/** Wordmark left, the event's own date right. */
export function brandHeader(dateStr: string): string {
  return `
  <table role="presentation" width="540" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;margin:0 auto 20px;">
    <tr>
      <td align="left" style="padding:0 6px;">
        ${aurumStar(18)}
        <span style="display:inline-block;margin-left:10px;font-family:${FONT_SERIF};font-size:17px;font-weight:500;letter-spacing:5.4px;color:#1a1614;vertical-align:middle;">A U R U M</span>
      </td>
      <td align="right" style="padding:0 6px;font-family:${FONT_SANS};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a8579;">
        ${dateStr}
      </td>
    </tr>
  </table>`;
}

/**
 * Hairline rule with a centre dot. The dot colour is the accent of the
 * email it sits in — gold for a purchase, green for a payout, bronze for
 * a cancellation — so the divider carries the same signal as the top rule.
 */
export function ornamentDivider(dotColor = '#C9A961'): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0;">
    <tr>
      <td style="padding:0 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="height:1px;background:linear-gradient(90deg,transparent,#E7DFC5,transparent);font-size:0;line-height:0;">&nbsp;</td>
            <td width="16" align="center">
              <div style="width:4px;height:4px;border-radius:50%;background:${dotColor};margin:0 auto;"></div>
            </td>
            <td style="height:1px;background:linear-gradient(90deg,transparent,#E7DFC5,transparent);font-size:0;line-height:0;">&nbsp;</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

export function emailFooter(): string {
  return `
  <table role="presentation" width="540" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;margin:24px auto 0;">
    <tr>
      <td align="center" style="padding:8px 24px 0;font-family:${FONT_SANS};font-size:11px;color:#8a8579;line-height:1.7;">
        <div style="margin-bottom:8px;">
          ${aurumStar(11)}
          <span style="display:inline-block;margin-left:8px;font-family:${FONT_SERIF};font-size:13px;letter-spacing:3.9px;color:#57534e;font-weight:500;vertical-align:middle;">A U R U M</span>
        </div>
        <div>Creator LiveTech · Pathum Thani, Thailand</div>
        <div>Support · <a href="mailto:support@creatorlivetech.com" style="color:#8a8579;text-decoration:none;">support@creatorlivetech.com</a></div>
        <div style="margin-top:6px;font-size:10px;color:#a8a29e;">This is an automated notification from your AURUM wallet.</div>
      </td>
    </tr>
  </table>`;
}

/**
 * The one media query in the set drops the card's side padding on narrow
 * screens. Clients that strip &lt;style&gt; simply keep the desktop padding,
 * which still fits — the layout does not depend on the query landing.
 */
export function emailWrapper(inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>AURUM</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Noto+Sans+Thai:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; background:#F5EEDA; }
  a { text-decoration:none; }
  @media only screen and (max-width:600px) {
    .card-inner { padding-left:20px !important; padding-right:20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F5EEDA;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5EEDA;">
  <tr>
    <td align="center" style="padding:36px 24px 40px;">
      ${inner}
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * A label/value line in the details block. `kind` picks the value's
 * treatment: serif for the one figure that carries the email, mono for
 * reference numbers, plain sans otherwise.
 */
export function detailRow(
  label: string,
  value: string,
  kind: 'serif' | 'mono' | 'plain' = 'plain',
  last = false,
): string {
  const valueStyle = kind === 'serif'
    ? `font-family:${FONT_SERIF};font-size:18px;font-weight:500;color:#1a1614;`
    : kind === 'mono'
    ? `font-family:${FONT_MONO};font-size:12px;letter-spacing:0.24px;color:#57534e;`
    : `font-family:${FONT_SANS};font-size:13px;color:#1a1614;font-weight:400;`;
  const border = last ? '' : 'border-bottom:1px solid #F5F0DF;';
  return `<tr>
    <td style="padding:14px 0;${border}font-family:${FONT_SANS};font-size:11px;letter-spacing:1.32px;text-transform:uppercase;color:#8a8579;font-weight:500;">${label}</td>
    <td align="right" style="padding:14px 0;${border}${valueStyle}">${value}</td>
  </tr>`;
}

/**
 * The pale gold panel that closes the purchase and refund emails with the
 * balance and the date it expires. Stars expire six months after the
 * batch that created them, so the expiry belongs next to the number.
 */
export function balancePanel(label: string, stars: number, validUntil: string): string {
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(135deg,#FBF6E8,#F5EBCF);border:1px solid #F0E7CB;border-radius:10px;">
        <tr>
          <td style="padding:20px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td>
                  ${aurumStar(32)}
                  <span style="display:inline-block;vertical-align:middle;margin-left:14px;">
                    <div style="font-family:${FONT_SANS};font-size:10px;letter-spacing:2.2px;text-transform:uppercase;color:#8a8579;margin:0 0 4px;font-weight:500;">${label}</div>
                    <div style="font-family:${FONT_SERIF};font-size:22px;font-weight:500;color:#1a1614;line-height:1;">${stars}<span style="font-size:14px;color:#8a8579;font-weight:400;font-style:italic;margin-left:4px;">stars</span></div>
                  </span>
                </td>
                <td align="right" style="font-family:${FONT_SANS};font-size:11px;color:#8a8579;line-height:1.5;">
                  Valid until<br>
                  <strong style="color:#57534e;font-weight:500;">${validUntil}</strong>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;
}
