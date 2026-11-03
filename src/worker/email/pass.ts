import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import type { PassSummary } from './pass-summary.ts';
import { safeMail, safeUrl } from './safe.ts';
import {
  buttonHtml,
  EMAIL_LIGHT as c,
  emailShell,
  escapeHtml,
  RADIUS,
  titleHtml,
  type,
} from './shell.ts';

export interface PassEmailInput {
  orgName: string;
  supportEmail?: string | null;
  supportUrl?: string | null;
  lang?: string;
  downloadUrl: string;
  /** The public pass page. */
  manageUrl: string;
  /**
   * Apple's black badge PNG at @2x (absolute URL). It sits on a white cell that dark mail clients
   * keep, so it never lands on a dark card until the outline artwork ships.
   */
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

export const ADD_LINE = HOLDER_COPY.openOnApple;
const PRIVATE_LINE = 'Keep this email private. Its links open your pass.';

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
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;border-collapse:separate"><tr><td style="background:${bg};border-radius:${RADIUS.lg}px;padding:16px 18px">${logo}${title}${table}</td></tr></table>`;
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
    `<p class="e-muted" style="margin:${margin};${type('sm')};color:${c.muted}">${line}</p>`;
  const body = `${titleHtml('Your pass is ready', '0 0 16px')}
${passBlock(input, fields)}
<p style="margin:0 0 16px"><a href="${escapeHtml(input.downloadUrl)}" style="display:inline-block;padding:4px;border-radius:${RADIUS.lg}px;background:#ffffff;text-decoration:none"><img src="${escapeHtml(input.badgeUrl)}" alt="Add to Apple Wallet" width="150" style="display:block;width:150px;height:auto;border:0"></a></p>
<p style="margin:0 0 16px">${buttonHtml(input.manageUrl, 'Open your pass', false)}</p>
${muted('0 0 24px', ADD_LINE)}
${input.attached ? muted('0 0 16px', 'The pass is also attached.') : ''}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${PRIVATE_LINE}</p>
${supportHtml ? `<p class="e-muted" style="margin:12px 0 0;${type('xs')};color:${c.muted}">Questions: ${supportHtml}</p>` : ''}`;
  const html = emailShell({
    lang: input.lang ?? 'en',
    title: subject,
    header: input.orgName,
    body,
  });
  const sender = input.senderName?.trim();
  return { subject, html, text, ...(sender ? { fromName: `${input.orgName} via ${sender}` } : {}) };
}
