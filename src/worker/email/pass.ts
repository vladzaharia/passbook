import { safeMail, safeUrl } from './safe.ts';
import { EMAIL_LIGHT as c, emailShell, escapeHtml } from './shell.ts';

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

const safeColor = (value: string | null | undefined) =>
  value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#1f2937';

export function renderPassEmail(input: PassEmailInput): RenderedEmail {
  const supportEmail = safeMail(input.supportEmail);
  const supportUrl = safeUrl(input.supportUrl);
  const supportText = [supportEmail, supportUrl].filter(Boolean).join(' | ');
  const supportHtml = [
    supportEmail
      ? `<a href="mailto:${escapeHtml(supportEmail)}" class="e-muted" style="color:${c.muted}">${escapeHtml(supportEmail)}</a>`
      : '',
    supportUrl
      ? `<a href="${escapeHtml(supportUrl)}" class="e-muted" style="color:${c.muted}">${escapeHtml(supportUrl)}</a>`
      : '',
  ]
    .filter(Boolean)
    .join(' | ');
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
  const body = `<p class="e-strong" style="margin:0 0 20px;font-size:20px;line-height:28px;font-weight:600;color:${c.strong}">Your pass is ready</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(input.downloadUrl)}" style="display:inline-block;text-decoration:none"><img src="${escapeHtml(input.badgeUrl)}" alt="Add to Apple Wallet" width="168" style="display:block;width:168px;height:auto;border:0"></a></p>
<p style="margin:0 0 24px"><a class="e-link" href="${escapeHtml(input.manageUrl)}" style="color:${accent};font-size:14px;font-weight:500">Manage pass</a></p>
${input.attached ? `<p class="e-muted" style="margin:0 0 16px;font-size:14px;line-height:20px;color:${c.muted}">The pass is also attached.</p>` : ''}
<p class="e-muted" style="margin:0;font-size:12px;line-height:18px;color:${c.muted}">Keep this email private. Its links open your pass.</p>
${supportHtml ? `<p class="e-muted" style="margin:12px 0 0;font-size:12px;line-height:18px;color:${c.muted}">Questions: ${supportHtml}</p>` : ''}`;
  const html = emailShell({
    lang: input.lang ?? 'en',
    title: subject,
    header: input.orgName,
    headerColor: accent,
    body,
  });
  return { subject, html, text };
}
