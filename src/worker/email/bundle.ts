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
  supportFooter,
  testNoteHtml,
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
  /** A test bundle's email carries the amber strip. */
  mode?: 'live' | 'test';
  buddyBase?: string | null;
}

const TITLE = 'Your passes';
const OPEN_LABEL = 'Open your passes';
const PRIVATE_LINE = 'Keep this email private. Its links open your passes.';
const GAP = 12;

/** A 44 px row: the link carries the padding, so the whole line is its hit area. */
const row = (p: BundleEmailInput['passes'][number]) => {
  const edge = `border-top:1px solid ${c.line}`;
  const link = `display:inline-block;padding:12px 0 12px 12px;color:${c.accent};text-decoration:underline`;
  return `<tr><td class="e-strong e-line" valign="middle" style="padding:12px 12px 12px 0;${edge};${type('sm')};font-weight:500;color:${c.strong};word-break:break-word">${escapeHtml(p.title)}</td><td class="e-line" align="right" valign="middle" style="padding:0;${edge};${type('sm')};white-space:nowrap">${
    p.addUrl
      ? `<a class="e-link" href="${escapeHtml(p.addUrl)}" style="${link}">Add</a>`
      : `<span class="e-muted" style="display:inline-block;padding:12px 0 12px 12px;color:${c.muted}">Voided</span>`
  }</td></tr>`;
};

/** The bundle email: the Add all badge, a way to the page and one row per pass. */
export function renderBundleEmail(input: BundleEmailInput): RenderedEmail {
  const footer = supportFooter(safeMail(input.supportEmail), safeUrl(input.supportUrl));
  const subject = `Your ${input.orgName} passes`;
  const { width, height } = EMAIL_BADGE;
  const badge = `<a href="${escapeHtml(input.addAllUrl)}" style="display:block;text-decoration:none"><img src="${escapeHtml(input.badgeUrl)}" alt="${APPLE_BADGE_ALT}" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px;border:0"></a>`;
  const item = (inner: string, right: string) =>
    `<div style="display:inline-block;vertical-align:top;width:${width}px;margin:0 ${right} ${GAP}px 0">${inner}</div>`;
  const actions = `<div style="margin:0 0 4px;font-size:0;line-height:0">${item(badge, `${GAP}px`)}${item(badgeButtonHtml(input.pageUrl, OPEN_LABEL), '0')}</div>`;
  const rows = input.passes.map(row).join('');
  const text = [
    TITLE,
    `${input.bundleName} · ${HOLDER_COPY.count(input.passes.length)}`,
    ...(input.mode === 'test' ? [HOLDER_COPY.testNote('bundle')] : []),
    '',
    ...input.passes.map((p) => `${p.title}${p.addUrl ? `: ${p.addUrl}` : ' (voided)'}`),
    '',
    `Add all to Apple Wallet: ${input.addAllUrl}`,
    `${OPEN_LABEL}: ${input.pageUrl}`,
    HOLDER_COPY.openOnApple,
    '',
    PRIVATE_LINE,
    ...footer.text,
  ].join('\n');
  const muted = (margin: string, line: string) =>
    `<p class="e-muted" style="margin:${margin};${type('sm')};color:${c.muted}">${line}</p>`;
  const body = `${titleHtml(TITLE, '0 0 4px')}
${muted('0 0 16px', `${escapeHtml(input.bundleName)} · ${HOLDER_COPY.count(input.passes.length)}`)}
${input.mode === 'test' ? testNoteHtml(HOLDER_COPY.testNote('bundle')) : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;border-collapse:collapse">${rows}</table>
${actions}
${muted('0 0 24px', escapeHtml(HOLDER_COPY.openOnApple))}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${PRIVATE_LINE}</p>
${footer.html}`;
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
