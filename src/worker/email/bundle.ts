import { APPLE_BADGE_ALT } from '../../shared/apple-badge.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { EMAIL_BADGE, PASS_EMAIL_MOOD } from '../../shared/email-art.ts';
import type { RenderedEmail } from './pass.ts';
import { safeMail, safeUrl } from './safe.ts';
import {
  badgeButtonHtml,
  EMAIL_LIGHT as c,
  emailShell,
  escapeHtml,
  titleHtml,
  type,
} from './shell.ts';

export interface BundleEmailInput {
  orgName: string;
  bundleName: string;
  supportEmail?: string | null;
  supportUrl?: string | null;
  /** The bundle page. */
  pageUrl: string;
  /** `/b/:token/passes.pkpasses`. */
  addAllUrl: string;
  badgeUrl: string;
  /** One row each; a voided pass has no link. */
  passes: { title: string; addUrl: string | null }[];
  iconUrl?: string | null;
  senderName?: string | null;
  buddyBase?: string | null;
}

const TITLE = 'Your passes';
const OPEN_LABEL = 'Open your passes';
const PRIVATE_LINE = 'Keep this email private. Its links open your passes.';
const GAP = 12;

const row = (p: BundleEmailInput['passes'][number]) =>
  `<tr><td class="e-strong" style="padding:10px 12px 10px 0;border-top:1px solid ${c.line};${type('sm')};font-weight:500;color:${c.strong};word-break:break-word">${escapeHtml(p.title)}</td><td align="right" style="padding:10px 0;border-top:1px solid ${c.line};${type('sm')};white-space:nowrap">${
    p.addUrl
      ? `<a href="${escapeHtml(p.addUrl)}" style="color:${c.accent};text-decoration:underline">Add</a>`
      : `<span class="e-muted" style="color:${c.muted}">Voided</span>`
  }</td></tr>`;

/** The bundle email: the Add all badge, a way to the page and one row per pass. */
export function renderBundleEmail(input: BundleEmailInput): RenderedEmail {
  const supportEmail = safeMail(input.supportEmail);
  const supportUrl = safeUrl(input.supportUrl);
  const support = [supportEmail, supportUrl].filter(Boolean).join(' | ');
  const subject = `Your ${input.orgName} passes`;
  const { width, height } = EMAIL_BADGE;
  const badge = `<a href="${escapeHtml(input.addAllUrl)}" style="display:block;text-decoration:none"><img src="${escapeHtml(input.badgeUrl)}" alt="${APPLE_BADGE_ALT}" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px;border:0"></a>`;
  const item = (inner: string, right: string) =>
    `<div style="display:inline-block;vertical-align:top;width:${width}px;margin:0 ${right} ${GAP}px 0">${inner}</div>`;
  const actions = `<div style="margin:0 0 4px;font-size:0;line-height:0">${item(badge, `${GAP}px`)}${item(badgeButtonHtml(input.pageUrl, OPEN_LABEL), '0')}</div>`;
  const rows = input.passes.map(row).join('');
  const text = [
    TITLE,
    input.bundleName,
    '',
    ...input.passes.map((p) => `${p.title}${p.addUrl ? `: ${p.addUrl}` : ' (voided)'}`),
    '',
    `Add all to Apple Wallet: ${input.addAllUrl}`,
    `${OPEN_LABEL}: ${input.pageUrl}`,
    HOLDER_COPY.openOnApple,
    '',
    PRIVATE_LINE,
    ...(support ? [`Questions: ${support}`] : []),
  ].join('\n');
  const muted = (margin: string, line: string) =>
    `<p class="e-muted" style="margin:${margin};${type('sm')};color:${c.muted}">${line}</p>`;
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
  const body = `${titleHtml(TITLE, '0 0 4px')}
${muted('0 0 16px', escapeHtml(input.bundleName))}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;border-collapse:collapse">${rows}</table>
${actions}
${muted('0 0 24px', escapeHtml(HOLDER_COPY.openOnApple))}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${PRIVATE_LINE}</p>
${supportHtml ? `<p class="e-muted" style="margin:12px 0 0;${type('xs')};color:${c.muted}">Questions: ${supportHtml}</p>` : ''}`;
  const buddyBase = safeUrl(input.buddyBase);
  const mark = safeUrl(input.iconUrl);
  const html = emailShell({
    lang: 'en',
    title: subject,
    header: input.orgName,
    ...(mark ? { headerMark: mark } : {}),
    ...(buddyBase ? { buddy: { base: buddyBase, mood: PASS_EMAIL_MOOD, tier: 'm' } } : {}),
    body,
  });
  const sender = input.senderName?.trim();
  return { subject, html, text, ...(sender ? { fromName: `${input.orgName} via ${sender}` } : {}) };
}
