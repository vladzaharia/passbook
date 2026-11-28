import { APPLE_BADGE_ALT } from '../../shared/apple-badge.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { JOIN_COPY } from '../../shared/copy/join.ts';
import { EMAIL_BADGE, PASS_EMAIL_MOOD } from '../../shared/email-art.ts';
import { displayFromName } from '../../shared/email-from-name.ts';
import { contrast, parseColor } from '../../shared/pass-view/color.ts';
import { NATIVE_WALLET_BADGES } from '../../shared/wallet-choice.ts';
import type { WalletOffer } from '../modules/wallet-providers/offers.ts';
import type { PassSummary } from './pass-summary.ts';
import { safeMail, safeUrl } from './safe.ts';
import {
  badgeButtonHtml,
  EMAIL_LIGHT as c,
  type EmailBrand,
  emailShell,
  escapeHtml,
  markLine,
  RADIUS,
  scalable,
  stackHtml,
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
  /** The .pkpass link; null while Apple is off for this pass (no badge, no attachment). */
  downloadUrl: string | null;
  /** The print page, when paper is on and the template lets the holder print. */
  printUrl?: string | null;
  /** The public pass page. */
  manageUrl: string;
  /** Apple's black badge PNG (absolute URL), drawn in the EMAIL_BADGE box. */
  badgeUrl: string;
  /** The public base and currently available native wallet offers for this pass. */
  publicBaseUrl?: string | null;
  walletOffers?: readonly WalletOffer[];
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
  /** The org's own From name (already checked): "<fromName> via <sender>" instead of "<Org> via <sender>". */
  fromName?: string | null;
  /** The template's own subject line (already rendered): used instead of "Your <Org> pass". */
  subject?: string | null;
  /** A test pass's email carries the amber strip. */
  mode?: 'live' | 'test';
  /** The card came from a join link: the mail says why the address got it. */
  joined?: boolean;
  /** A copy stopped working or the code changed: the heading, line and subject replace "ready". */
  notice?: { subject: string; title: string; line: string };
  /**
   * PUBLIC_BASE_URL when the org opted in (`email.buddy`): the buddy sits at the band's right end,
   * as in the sign-in email. Absent, the band is the org's mark and name alone.
   */
  buddyBase?: string | null;
  /** The org's web logo and mark level (`emailBrandOf`). */
  brand?: EmailBrand;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** The From display name, when the template sets one. */
  fromName?: string;
}

export const ADD_LINE = HOLDER_COPY.emailAddLine;
const PRIVATE_LINE = 'Keep this email private. Its links open your pass.';
const OPEN_LABEL = 'Open your pass';
const PRINT_LABEL = 'Print ticket';

type EmailWalletOffer = Pick<WalletOffer, 'provider' | 'href'>;

/** Wallet's logo box is 160×50 pt; the email draws the logo at most this tall. */
const LOGO = { width: 160, height: 36 };
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
    ? `<td style="padding:0 0 0 10px;vertical-align:middle;${scalable(16, 20)};font-weight:600;color:${fg}">${escapeHtml(text)}</td>`
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
    ? `<p style="margin:0 0 ${fields.length ? 12 : 0}px;${scalable(17, 22)};font-weight:600;color:${fg}">${escapeHtml(input.passTitle)}</p>`
    : '';
  const rows = fields
    .map(
      (f) =>
        `<tr><td style="padding:4px 12px 4px 0;${scalable(12, 16)};color:${label};white-space:nowrap;vertical-align:top">${escapeHtml(f.label)}</td><td style="padding:4px 0;${scalable(14, 18)};font-weight:500;color:${fg};vertical-align:top">${escapeHtml(f.value)}</td></tr>`,
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
 * The badge, then its button, stacked on the card's text edge: the badge adds, the button only
 * opens, so they are never a side-by-side pair. A table row each, so every client keeps the gap.
 */
function actionsHtml(input: PassEmailInput): string {
  const { width, height } = EMAIL_BADGE;
  const badge = input.downloadUrl
    ? `<a href="${escapeHtml(input.downloadUrl)}" style="display:block;text-decoration:none"><img src="${escapeHtml(input.badgeUrl)}" alt="${APPLE_BADGE_ALT}" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px;border:0"></a>`
    : null;
  const items = [...(badge ? [badge] : []), badgeButtonHtml(input.manageUrl, OPEN_LABEL)];
  const [first, second] = items;
  if (badge && items.length === 2 && first && second) return stackHtml(first, second);
  const rows = items
    .map(
      (item, i) =>
        `<tr><td style="padding:${i < items.length - 1 ? '0 0 12px' : '0'}">${item}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 ${badge ? 4 : 24}px;border-collapse:collapse">${rows}</table>`;
}

/** Print is a link under the one button, not a second button. */
const printLinkHtml = (url: string) =>
  `<p style="margin:8px 0 16px"><a class="e-link" href="${escapeHtml(url)}" style="${type('sm')};color:${c.text};text-decoration:underline">${PRINT_LABEL}</a></p>`;

/** Only render capability links for the same pass as the Apple and public-page links. */
function emailWalletOffers(
  input: PassEmailInput,
): { base: string; offers: EmailWalletOffer[] } | null {
  const base = safeUrl(input.publicBaseUrl);
  if (!base) return null;
  const offers = (input.walletOffers ?? []).flatMap(({ provider, href }) => {
    const absolute = safeUrl(`${base}${href}`);
    return absolute && absolute === `${input.manageUrl}/wallet/${provider}`
      ? [{ provider, href: absolute }]
      : [];
  });
  return { base, offers };
}

/** Native badges are unmodified, proportionally sized and stacked for narrow mail clients. */
function walletActionsHtml(base: string, offers: readonly EmailWalletOffer[]): string {
  if (!offers.length) return '';
  const rows = offers
    .map(({ provider, href }) => {
      const badge = NATIVE_WALLET_BADGES[provider];
      const link = escapeHtml(href);
      return `<tr><td style="padding:0 0 16px"><a href="${link}" style="display:block;text-decoration:none"><img src="${escapeHtml(`${base}${badge.emailPath}`)}" alt="${badge.label}" width="${badge.width}" height="${badge.height}" style="display:block;width:${badge.width}px;max-width:100%;height:auto;border:0"></a><a class="e-link" href="${link}" style="display:inline-block;margin:8px 0 0;${type('xs')};color:${c.text};text-decoration:underline">${badge.label}</a></td></tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">${rows}</table>`;
}

export function renderPassEmail(input: PassEmailInput): RenderedEmail {
  const footer = supportFooter(safeMail(input.supportEmail), safeUrl(input.supportUrl));
  const wallets = emailWalletOffers(input);
  const printUrl = safeUrl(input.printUrl);
  const subject =
    input.notice?.subject ??
    (input.subject?.trim() ||
      (input.joined
        ? `Your ${JOIN_COPY.mailSubject.replace('{org}', input.orgName)}`
        : `Your ${input.orgName} pass`));
  const ready = input.notice?.title ?? (input.joined ? JOIN_COPY.mailTitle : HOLDER_COPY.passReady);
  const joinLine = input.joined ? JOIN_COPY.mailLine.replace('{org}', input.orgName) : null;
  const fields = (input.summary?.fields ?? [])
    .filter((f) => f.value !== input.passTitle)
    .slice(0, 3);
  const text = [
    ready,
    ...(input.notice ? [input.notice.line] : []),
    ...(input.mode === 'test' ? [HOLDER_COPY.testNote('pass')] : []),
    ...(input.passTitle ? ['', input.passTitle] : []),
    ...fields.map((f) => `${f.label ? `${f.label}: ` : ''}${f.value}`),
    '',
    ...(input.downloadUrl ? [`${APPLE_BADGE_ALT}: ${input.downloadUrl}`] : []),
    `${OPEN_LABEL}: ${input.manageUrl}`,
    ...(printUrl ? [`${PRINT_LABEL}: ${printUrl}`] : []),
    ...(input.downloadUrl ? [ADD_LINE] : []),
    ...(wallets?.offers.length
      ? [
          '',
          ...wallets.offers.map(
            ({ provider, href }) => `${NATIVE_WALLET_BADGES[provider].label}: ${href}`,
          ),
        ]
      : []),
    ...(input.attached ? ['', 'The pass is also attached.'] : []),
    ...(joinLine ? ['', joinLine] : []),
    '',
    PRIVATE_LINE,
    ...footer.text,
    ...(markLine(input.brand?.mark) ? ['', markLine(input.brand?.mark) as string] : []),
  ].join('\n');
  const muted = (margin: string, line: string) =>
    `<p class="e-muted" style="margin:${margin};${type('sm')};color:${c.muted}">${line}</p>`;
  const body = `${titleHtml(ready, '0 0 16px')}
${input.notice ? muted('0 0 16px', escapeHtml(input.notice.line)) : ''}
${input.mode === 'test' ? testNoteHtml(HOLDER_COPY.testNote('pass')) : ''}
${passBlock(input, fields)}
${actionsHtml(input)}
${printUrl ? printLinkHtml(printUrl) : ''}
${input.downloadUrl ? muted('0 0 24px', ADD_LINE) : ''}
${wallets ? walletActionsHtml(wallets.base, wallets.offers) : ''}
${input.attached ? muted('0 0 16px', 'The pass is also attached.') : ''}
${joinLine ? muted('0 0 16px', escapeHtml(joinLine)) : ''}
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
    ...(input.brand ? { brand: input.brand } : {}),
    ...(buddyBase ? { buddy: { base: buddyBase, mood: PASS_EMAIL_MOOD } } : {}),
    body,
  });
  const sender = input.senderName?.trim();
  const fromName = displayFromName(input.fromName || input.orgName, sender);
  return { subject, html, text, fromName };
}
