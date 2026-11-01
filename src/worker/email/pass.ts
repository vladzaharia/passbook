import type { PassSummary } from './pass-summary.ts';
import { safeMail, safeUrl } from './safe.ts';
import { buttonHtml, EMAIL_LIGHT as c, emailShell, escapeHtml, linkColor } from './shell.ts';

export interface PassEmailInput {
  orgName: string;
  /** `#rrggbb`; falls back to a neutral dark. */
  accent?: string | null;
  supportEmail?: string | null;
  supportUrl?: string | null;
  lang?: string;
  downloadUrl: string;
  /** The public pass page. */
  manageUrl: string;
  /** Apple's badge PNG at @2x (absolute URL). */
  badgeUrl: string;
  attached: boolean;
  /** The pass's title (display title, else its description). */
  passTitle?: string | null;
  /** Key fields and colours from the built pass; shown before the badge. */
  summary?: PassSummary | null;
  /** The org's logo (absolute URL) when it is branded. */
  logoUrl?: string | null;
  /** The platform sender name: the From name becomes "<Org> via <sender>". */
  senderName?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** The From display name, when the template sets one. */
  fromName?: string;
}

export const ADD_LINE = 'Open on iPhone or Mac to add to Wallet.';
const PRIVATE_LINE = 'Keep this email private. Its links open your pass.';

const safeColor = (value: string | null | undefined) =>
  value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#1f2937';

/** The pass, drawn small in its own colours: logo, title and two or three fields. */
function passBlock(input: PassEmailInput, fields: PassSummary['fields']): string {
  const s = input.summary;
  if (!s && !input.passTitle) return '';
  const bg = s?.colors.background ?? c.sunken;
  const fg = s?.colors.foreground ?? c.strong;
  const label = s?.colors.label ?? c.muted;
  const logo = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" alt="${escapeHtml(input.orgName)}" height="24" style="display:block;height:24px;width:auto;border:0;margin:0 0 12px">`
    : '';
  const title = input.passTitle
    ? `<p style="margin:0 0 ${fields.length ? 12 : 0}px;font-size:17px;line-height:22px;font-weight:600;color:${fg}">${escapeHtml(input.passTitle)}</p>`
    : '';
  const rows = fields
    .map(
      (f) =>
        `<tr><td style="padding:4px 12px 4px 0;font-size:12px;line-height:16px;color:${label};white-space:nowrap;vertical-align:top">${escapeHtml(f.label)}</td><td style="padding:4px 0;font-size:14px;line-height:18px;font-weight:500;color:${fg};vertical-align:top">${escapeHtml(f.value)}</td></tr>`,
    )
    .join('');
  const table = rows
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${rows}</table>`
    : '';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;border-collapse:separate"><tr><td style="background:${bg};border-radius:12px;padding:16px 18px">${logo}${title}${table}</td></tr></table>`;
}

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
  const link = linkColor(accent);
  const subject = `Your ${input.orgName} pass`;
  const fields = (input.summary?.fields ?? [])
    .filter((f) => f.value !== input.passTitle)
    .slice(0, 3);
  const text = [
    'Your pass is ready',
    ...(input.passTitle ? ['', input.passTitle] : []),
    ...fields.map((f) => `${f.label ? `${f.label}: ` : ''}${f.value}`),
    '',
    `Add to Apple Wallet: ${input.downloadUrl}`,
    `Open your pass: ${input.manageUrl}`,
    ADD_LINE,
    ...(input.attached ? ['', 'The pass is also attached.'] : []),
    '',
    PRIVATE_LINE,
    ...(supportText ? [`Questions: ${supportText}`] : []),
  ].join('\n');
  const muted = (margin: string, line: string) =>
    `<p class="e-muted" style="margin:${margin};font-size:14px;line-height:20px;color:${c.muted}">${line}</p>`;
  const body = `<p class="e-strong" style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;color:${c.strong}">Your pass is ready</p>
${passBlock(input, fields)}
<p style="margin:0 0 16px"><a href="${escapeHtml(input.downloadUrl)}" style="display:inline-block;text-decoration:none"><img src="${escapeHtml(input.badgeUrl)}" alt="Add to Apple Wallet" width="168" style="display:block;width:168px;height:auto;border:0"></a></p>
<p style="margin:0 0 16px">${buttonHtml(input.manageUrl, 'Open your pass', false, link)}</p>
${muted('0 0 24px', ADD_LINE)}
${input.attached ? muted('0 0 16px', 'The pass is also attached.') : ''}
<p class="e-muted" style="margin:0;font-size:12px;line-height:18px;color:${c.muted}">${PRIVATE_LINE}</p>
${supportHtml ? `<p class="e-muted" style="margin:12px 0 0;font-size:12px;line-height:18px;color:${c.muted}">Questions: ${supportHtml}</p>` : ''}`;
  const html = emailShell({
    lang: input.lang ?? 'en',
    title: subject,
    header: input.orgName,
    headerColor: accent,
    body,
  });
  const sender = input.senderName?.trim();
  return { subject, html, text, ...(sender ? { fromName: `${input.orgName} via ${sender}` } : {}) };
}
