import { APPLE_BADGE_ALT } from '../../shared/apple-badge.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { EMAIL_BADGE, PASS_EMAIL_MOOD } from '../../shared/email-art.ts';
import { displayFromName } from '../../shared/email-from-name.ts';
import type { RenderedEmail } from './pass.ts';
import { safeMail, safeUrl } from './safe.ts';
import {
  badgeButtonHtml,
  EMAIL_LIGHT as c,
  type EmailBrand,
  emailShell,
  escapeHtml,
  markLine,
  stackHtml,
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
  /** `/b/:token/passes.pkpasses`; null when Apple is off for every addable pass. */
  addAllUrl: string | null;
  badgeUrl: string;
  /** One row each; a voided pass has no link, `off` marks a live one Apple is off for. */
  passes: {
    title: string;
    addUrl: string | null;
    off?: boolean;
    detail?: string | null;
    /** Native wallets allowed for this pass: the unmodified PNG badge (Gmail cannot draw SVG), then a text link. */
    wallets?: {
      label: string;
      url: string;
      badge: { url: string; width: number; height: number };
    }[];
  }[];
  iconUrl?: string | null;
  senderName?: string | null;
  /** The org's own From name (already checked): shown as "<fromName> via <sender>". */
  fromName?: string | null;
  /** A test bundle's email carries the amber strip. */
  mode?: 'live' | 'test';
  buddyBase?: string | null;
  /** The org's web logo and mark level (`emailBrandOf`). */
  brand?: EmailBrand;
}

const TITLE = 'Your passes';
const OPEN_LABEL = 'Open your passes';
const PRIVATE_LINE = 'Keep this email private. Its links open your passes.';

/** A 44 px row: the link carries the padding, so the whole line is its hit area. */
const row = (p: BundleEmailInput['passes'][number]) => {
  const edge = `border-top:1px solid ${c.line}`;
  const link = `display:inline-block;padding:11px 16px;border:1px solid ${c.accent};border-radius:8px;color:${c.accent};text-decoration:none;font-weight:500`;
  const detail = p.detail
    ? `<br><span class="e-muted" style="font-weight:400;color:${c.muted}">${escapeHtml(p.detail)}</span>`
    : '';
  const wallets = (p.wallets ?? [])
    .flatMap((w) => {
      const url = safeUrl(w.url);
      const art = safeUrl(w.badge.url);
      if (!url || !art) return [];
      const { width, height } = w.badge;
      return [
        `<a href="${escapeHtml(url)}" style="display:block;margin:8px 0 0;text-decoration:none"><img src="${escapeHtml(art)}" alt="${escapeHtml(w.label)}" width="${width}" height="${height}" style="display:block;width:${width}px;max-width:100%;height:auto;border:0"></a><a class="e-link" href="${escapeHtml(url)}" style="display:inline-block;margin:4px 0 0;font-weight:400;color:${c.text};text-decoration:underline">${escapeHtml(w.label)}</a>`,
      ];
    })
    .join('');
  return `<tr><td class="e-strong e-line" valign="middle" style="padding:12px 12px 12px 0;${edge};${type('sm')};font-weight:500;color:${c.strong};word-break:break-word">${escapeHtml(p.title)}${detail}${wallets}</td><td class="e-line" align="right" valign="middle" style="padding:0;${edge};${type('sm')};white-space:nowrap">${
    p.addUrl
      ? `<a class="e-link" href="${escapeHtml(p.addUrl)}" style="${link}">Add</a>`
      : `<span class="e-muted" style="display:inline-block;padding:12px 0 12px 12px;color:${c.muted}">${p.off ? '' : 'Voided'}</span>`
  }</td></tr>`;
};

/** The bundle email: the Add all badge, a way to the page and one row per pass. */
export function renderBundleEmail(input: BundleEmailInput): RenderedEmail {
  const footer = supportFooter(safeMail(input.supportEmail), safeUrl(input.supportUrl));
  const subject = `Your ${input.orgName} passes`;
  const { width, height } = EMAIL_BADGE;
  const badge = input.addAllUrl
    ? `<a href="${escapeHtml(input.addAllUrl)}" style="display:block;text-decoration:none"><img src="${escapeHtml(input.badgeUrl)}" alt="${APPLE_BADGE_ALT}" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px;border:0"></a>`
    : null;
  const open = badgeButtonHtml(input.pageUrl, OPEN_LABEL);
  const actions = badge
    ? stackHtml(badge, open)
    : `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 4px;border-collapse:collapse"><tr><td style="padding:0">${open}</td></tr></table>`;
  const rows = input.passes.map(row).join('');
  const addLine = input.passes.length === 1 ? HOLDER_COPY.emailAddLine : HOLDER_COPY.emailAddLines;
  const text = [
    TITLE,
    input.bundleName,
    ...(input.mode === 'test' ? [HOLDER_COPY.testNote('bundle')] : []),
    '',
    ...input.passes.map((p) =>
      [
        `${p.title}${p.detail ? ` (${p.detail})` : ''}${p.addUrl ? `: ${p.addUrl}` : p.off ? '' : ' (voided)'}`,
        ...(p.wallets ?? []).flatMap((w) => (safeUrl(w.url) ? [`  ${w.label}: ${w.url}`] : [])),
      ].join('\n'),
    ),
    '',
    ...(input.addAllUrl ? [`Add all to Apple Wallet: ${input.addAllUrl}`] : []),
    `${OPEN_LABEL}: ${input.pageUrl}`,
    ...(input.addAllUrl ? [addLine] : []),
    '',
    PRIVATE_LINE,
    ...footer.text,
    ...(markLine(input.brand?.mark) ? ['', markLine(input.brand?.mark) as string] : []),
  ].join('\n');
  const muted = (margin: string, line: string) =>
    `<p class="e-muted" style="margin:${margin};${type('sm')};color:${c.muted}">${line}</p>`;
  const body = `${titleHtml(TITLE, '0 0 4px')}
${muted('0 0 16px', escapeHtml(input.bundleName))}
${input.mode === 'test' ? testNoteHtml(HOLDER_COPY.testNote('bundle')) : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;border-collapse:collapse">${rows}</table>
${actions}
${input.addAllUrl ? muted('0 0 24px', escapeHtml(addLine)) : ''}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${PRIVATE_LINE}</p>
${footer.html}`;
  const buddyBase = safeUrl(input.buddyBase);
  const mark = safeUrl(input.iconUrl);
  const html = emailShell({
    lang: 'en',
    title: subject,
    header: input.orgName,
    ...(mark ? { headerMark: mark } : {}),
    ...(input.brand ? { brand: input.brand } : {}),
    ...(buddyBase ? { buddy: { base: buddyBase, mood: PASS_EMAIL_MOOD } } : {}),
    body,
  });
  const sender = input.senderName?.trim();
  const fromName = displayFromName(input.fromName || input.orgName, sender);
  return { subject, html, text, fromName };
}
