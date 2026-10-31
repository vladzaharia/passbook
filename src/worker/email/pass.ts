export interface PassEmailInput {
  orgName: string;
  /** `#rrggbb`; falls back to a neutral dark. */
  accent?: string | null;
  supportEmail?: string | null;
  supportUrl?: string | null;
  lang?: string;
  downloadUrl: string;
  manageUrl: string;
  badgeUrl: string;
  attached: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const safeColor = (value: string | null | undefined) =>
  value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#1f2937';

const safeUrl = (value: string | null | undefined) =>
  value && /^https?:\/\/[^\s"'<>]+$/i.test(value) ? value : null;
const safeMail = (value: string | null | undefined) =>
  value && /^[^\s@<>"']+@[^\s@<>"']+$/.test(value) ? value : null;

export function renderPassEmail(input: PassEmailInput): RenderedEmail {
  const supportEmail = safeMail(input.supportEmail);
  const supportUrl = safeUrl(input.supportUrl);
  const supportText = [supportEmail, supportUrl].filter(Boolean).join(' | ');
  const supportHtml = [
    supportEmail
      ? `<a href="mailto:${escapeHtml(supportEmail)}" style="color:#71717a">${escapeHtml(supportEmail)}</a>`
      : '',
    supportUrl
      ? `<a href="${escapeHtml(supportUrl)}" style="color:#71717a">${escapeHtml(supportUrl)}</a>`
      : '',
  ]
    .filter(Boolean)
    .join(' | ');
  const org = escapeHtml(input.orgName);
  const accent = safeColor(input.accent);
  const subject = `Your ${input.orgName} pass`;
  const text = [
    `Your ${input.orgName} pass`,
    '',
    `Add to Apple Wallet: ${input.downloadUrl}`,
    `Manage pass: ${input.manageUrl}`,
    ...(input.attached ? ['', 'The pass is also attached.'] : []),
    '',
    'Keep this email private. Its links open your pass.',
    ...(supportText ? [`Questions: ${supportText}`] : []),
  ].join('\n');
  const html = `<!doctype html>
<html lang="${escapeHtml(input.lang ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5">
<tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="480" cellspacing="0" cellpadding="0" style="width:100%;max-width:480px;background:#ffffff;border-radius:12px">
<tr><td style="background:${accent};padding:20px 24px;border-radius:12px 12px 0 0;color:#ffffff;font-size:18px;font-weight:600">${org}</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 20px;font-size:16px;line-height:24px">Your pass is ready.</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(input.downloadUrl)}" style="display:inline-block;text-decoration:none"><img src="${escapeHtml(input.badgeUrl)}" alt="Add to Apple Wallet" width="168" style="display:block;width:168px;height:auto;border:0"></a></p>
<p style="margin:0 0 24px"><a href="${escapeHtml(input.manageUrl)}" style="color:${accent};font-size:15px">Manage pass</a></p>
${input.attached ? '<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b">The pass is also attached.</p>' : ''}
<p style="margin:0;font-size:12px;line-height:18px;color:#71717a">Keep this email private. Its links open your pass.</p>
${supportHtml ? `<p style="margin:12px 0 0;font-size:12px;line-height:18px;color:#71717a">Questions: ${supportHtml}</p>` : ''}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject, html, text };
}
