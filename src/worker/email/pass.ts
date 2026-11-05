import { APPLE_BADGE_ALT } from '../../shared/apple-badge.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { EMAIL_BADGE, PASS_EMAIL_MOOD } from '../../shared/email-art.ts';
import { contrast, parseColor } from '../../shared/pass-view/color.ts';
import type { PassSummary } from './pass-summary.ts';
import { safeMail, safeUrl } from './safe.ts';
import {
  badgeButtonHtml,
  EMAIL_LIGHT as c,
  emailShell,
  escapeHtml,
  RADIUS,
  supportFooter,
  testNoteHtml,
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
  /** Apple's black badge PNG (absolute URL), drawn in the EMAIL_BADGE box. */
  badgeUrl: string;
  attached: boolean;
  /** The pass's title (display title, else its description). */
  passTitle?: string | null;
  /** Key fields and colours from the built pass; shown before the badge. */
  summary?: PassSummary | null;
  /** The pass's icon (absolute URL): the org's mark before its name in the band, as on `/p`. */
  iconUrl?: string | null;
  /** The pass's logo (absolute URL) and its size in points, drawn on the pass block. */
  logo?: { url: string; width: number; height: number } | null;
  /** The pass's logoText, beside the logo as in Wallet. Absent when the logo shows the name. */
  logoText?: string | null;
  /** The platform sender name: the From name becomes "<Org> via <sender>". */
  senderName?: string | null;
  /** A test pass's email carries the amber strip. */
  mode?: 'live' | 'test';
  /**
   * PUBLIC_BASE_URL when the org opted in (`email.buddy`): the buddy sits at the band's right end,
   * as in the sign-in email. Absent, the band is the org's mark and name alone.
   */
  buddyBase?: string | null;
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
const OPEN_LABEL = 'Open your pass';

/** Wallet's logo box is 160×50 pt; the email draws the logo at most this tall. */
const LOGO = { width: 160, height: 36 };
/** Between the badge and its button, side by side or stacked: more than its 0.1 × height. */
const GAP = 12;
const CARD = parseColor(c.card) ?? { r: 255, g: 255, b: 255 };

/** The logo row, as the pass's header: the logo, then logoText unless the logo has the name. */
function logoHtml(input: PassEmailInput, fg: string): string {
  const url = safeUrl(input.logo?.url);
  const { width = 0, height = 0 } = input.logo ?? {};
  if (!url || !(width > 0 && height > 0)) return '';
  const scale = Math.min(1, LOGO.width / width, LOGO.height / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const text = input.logoText?.trim();
  // Named beside it, the image adds nothing to read; alone, it is the org's name.
  const img = `<img src="${escapeHtml(url)}" alt="${text ? '' : escapeHtml(input.orgName)}" width="${w}" height="${h}" style="display:block;width:${w}px;height:${h}px;border:0">`;
  const name = text
    ? `<td style="padding:0 0 0 10px;vertical-align:middle;font-size:16px;line-height:20px;font-weight:600;color:${fg}">${escapeHtml(text)}</td>`
    : '';
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 14px;border-collapse:collapse"><tr><td style="vertical-align:middle">${img}</td>${name}</tr></table>`;
}

/** The pass, drawn small in its own colours: logo, title and two or three fields. */
function passBlock(input: PassEmailInput, fields: PassSummary['fields']): string {
  const s = input.summary;
  if (!s && !input.passTitle) return '';
  const bg = s?.colors.background ?? c.sunken;
  const fg = s?.colors.foreground ?? c.strong;
  const label = s?.colors.label ?? c.muted;
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
  // The card's hairline where the pass's colour would melt into the card: a light pass here, any
  // pass in dark clients (e-line). Elsewhere the edge is the pass's own colour.
  const bgRgb = parseColor(bg);
  const edge = !bgRgb || contrast(bgRgb, CARD) < 1.5 ? c.line : bg;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;border-collapse:separate"><tr><td class="e-line" style="background:${bg};border:1px solid ${edge};border-radius:${RADIUS.lg}px;padding:15px 17px">${logoHtml(input, fg)}${title}${table}</td></tr></table>`;
}

/**
 * The badge and its button: one box, side by side where the column fits both, else stacked, left
 * on the card's text edge. Inline blocks wrap without media queries (Gmail). Word-rendered Outlook
 * has no inline blocks and drops div margins, so it gets a fixed row instead: two 143 px cells and
 * a 12 px one between them.
 */
function actionsHtml(input: PassEmailInput): string {
  const { width, height } = EMAIL_BADGE;
  const notMso = (html: string) => `<!--[if !mso]><!-->${html}<!--<![endif]-->`;
  const mso = (html: string) => `<!--[if mso]>${html}<![endif]-->`;
  const cell = `<td width="${width}" valign="top" style="width:${width}px;padding:0 0 ${GAP}px">`;
  const item = (inner: string, right: string) =>
    `${notMso(`<div style="display:inline-block;vertical-align:top;width:${width}px;margin:0 ${right} ${GAP}px 0">`)}${inner}${notMso('</div>')}`;
  const badge = `<a href="${escapeHtml(input.downloadUrl)}" style="display:block;text-decoration:none"><img src="${escapeHtml(input.badgeUrl)}" alt="${APPLE_BADGE_ALT}" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px;border:0"></a>`;
  return `<div style="margin:0 0 4px;font-size:0;line-height:0">${mso(`<table role="presentation" cellspacing="0" cellpadding="0"><tr>${cell}`)}${item(badge, `${GAP}px`)}${mso(`</td><td width="${GAP}" style="width:${GAP}px;font-size:0;line-height:0">&nbsp;</td>${cell}`)}${item(badgeButtonHtml(input.manageUrl, OPEN_LABEL), '0')}${mso('</td></tr></table>')}</div>`;
}

export function renderPassEmail(input: PassEmailInput): RenderedEmail {
  const footer = supportFooter(safeMail(input.supportEmail), safeUrl(input.supportUrl));
  const subject = `Your ${input.orgName} pass`;
  const fields = (input.summary?.fields ?? [])
    .filter((f) => f.value !== input.passTitle)
    .slice(0, 3);
  const text = [
    HOLDER_COPY.passReady,
    ...(input.mode === 'test' ? [HOLDER_COPY.testNote('pass')] : []),
    ...(input.passTitle ? ['', input.passTitle] : []),
    ...fields.map((f) => `${f.label ? `${f.label}: ` : ''}${f.value}`),
    '',
    `${APPLE_BADGE_ALT}: ${input.downloadUrl}`,
    `${OPEN_LABEL}: ${input.manageUrl}`,
    ADD_LINE,
    ...(input.attached ? ['', 'The pass is also attached.'] : []),
    '',
    PRIVATE_LINE,
    ...footer.text,
  ].join('\n');
  const muted = (margin: string, line: string) =>
    `<p class="e-muted" style="margin:${margin};${type('sm')};color:${c.muted}">${line}</p>`;
  const body = `${titleHtml(HOLDER_COPY.passReady, '0 0 16px')}
${input.mode === 'test' ? testNoteHtml(HOLDER_COPY.testNote('pass')) : ''}
${passBlock(input, fields)}
${actionsHtml(input)}
${muted('0 0 24px', ADD_LINE)}
${input.attached ? muted('0 0 16px', 'The pass is also attached.') : ''}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${PRIVATE_LINE}</p>
${footer.html}`;
  // Images need an absolute URL, as in the sign-in email.
  const buddyBase = safeUrl(input.buddyBase);
  const mark = safeUrl(input.iconUrl);
  const html = emailShell({
    lang: input.lang ?? 'en',
    title: subject,
    header: input.orgName,
    ...(mark ? { headerMark: mark } : {}),
    ...(buddyBase ? { buddy: { base: buddyBase, mood: PASS_EMAIL_MOOD, tier: 'm' } } : {}),
    body,
  });
  const sender = input.senderName?.trim();
  return { subject, html, text, ...(sender ? { fromName: `${input.orgName} via ${sender}` } : {}) };
}
