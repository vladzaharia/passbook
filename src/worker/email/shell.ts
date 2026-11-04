import { EMAIL_TOKENS as T } from '../../generated/resolved-tokens.ts';
import {
  type BuddyTier,
  EMAIL_BADGE,
  EMAIL_BUDDY,
  type EmailMood,
} from '../../shared/email-art.ts';
import { escapeHtml } from '../../shared/html.ts';
import { buddySliceHtml } from './buddy.ts';

export { escapeHtml };

/** The SPA's light tokens, inlined; dark clients get the dark ones through DARK_CSS classes. */
export const EMAIL_LIGHT = T.light;

const D = T.dark;
/** Static only: no @keyframes, no GIFs (motion-and-expression.md, Email). */
const DARK_CSS = `:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.e-page{background:${D.page}!important}
.e-card{background:${D.card}!important;border-color:${D.line}!important}
.e-seam{background-color:${D.card}!important;background-image:linear-gradient(115deg,${D.foil1},${D.foil2} 55%,${D.foil3})!important}
.e-text{color:${D.text}!important}
.e-strong{color:${D.strong}!important}
.e-muted,.e-muted a{color:${D.muted}!important}
.e-btn{background:${D.accent}!important;border-color:${D.accent}!important;color:${D.accentOn}!important}
.e-block{border-color:${D.lineStrong}!important;color:${D.text}!important}
.e-chip{background:${D.sunken}!important;color:${D.strong}!important}
.e-line{border-color:${D.line}!important}
}`;

/**
 * Word-rendered Outlook only: 96 dpi so images keep their pixel boxes, no gaps beside nested tables,
 * and a system face, since it would fall back to Times for a stack it cannot read.
 */
const MSO_HEAD = `<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><style>table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}body,table,td,p,a{font-family:'Segoe UI',Arial,sans-serif!important}</style><![endif]-->`;

/** The SPA's sans stack (Rubik first, then its metric fallback and the system faces). */
export const FONT = T.font.sans;
/** The kit radii in px: md for controls and chips, lg for tiles, xl for the card. */
export const RADIUS = T.radius;
export const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** `font-size` and `line-height` of a type step, in px. */
export const type = (step: keyof typeof T.text) =>
  `font-size:${T.text[step].size}px;line-height:${T.text[step].line}px`;

/** The card's h1: 24/32, semibold, tight, as the hosted card. */
export const titleHtml = (text: string, margin: string) =>
  `<p class="e-strong" style="margin:${margin};${type('2xl')};font-weight:${T.weight.semibold};letter-spacing:${T.tracking};color:${EMAIL_LIGHT.strong}">${text}</p>`;

/**
 * A full-width 44 px link block (12 px padding, 20 px line): the kit Button's 14/500 type and
 * radius. `primary` fills it with the accent; else it is the outline variant, in neutral text.
 */
export function buttonHtml(href: string, label: string, primary: boolean) {
  const c = EMAIL_LIGHT;
  const look = primary
    ? `background:${c.accent};color:${c.accentOn};border:1px solid ${c.accent}`
    : `background:transparent;color:${c.text};border:1px solid ${c.lineStrong}`;
  return `<a class="${primary ? 'e-btn' : 'e-block'}" href="${escapeHtml(href)}" style="display:block;${look};text-align:center;text-decoration:none;${type('sm')};font-weight:${T.weight.medium};padding:11px 24px;border-radius:${T.radius.md}px">${escapeHtml(label)}</a>`;
}

/**
 * The outline button beside the Apple badge (the kit's `badge` size): the badge's box, and lg, the
 * radius step nearest its corner, so the two read as a pair. The cell draws the outline and sets the
 * height, so Outlook keeps the box (square, and only the label is the link there).
 */
export function badgeButtonHtml(href: string, label: string) {
  const c = EMAIL_LIGHT;
  const { width, height } = EMAIL_BADGE;
  const inner = height - 2;
  const r = T.radius.lg;
  return `<table role="presentation" width="${width}" cellspacing="0" cellpadding="0" style="width:${width}px;border-collapse:separate"><tr><td class="e-block" align="center" height="${inner}" style="height:${inner}px;padding:0;border:1px solid ${c.lineStrong};border-radius:${r}px"><a class="e-block" href="${escapeHtml(href)}" style="display:block;color:${c.text};font-family:${FONT};font-size:${T.text.sm.size}px;line-height:${inner}px;mso-line-height-rule:exactly;font-weight:${T.weight.medium};text-align:center;text-decoration:none;border-radius:${r}px">${escapeHtml(label)}</a></td></tr></table>`;
}

export interface ShellInput {
  lang: string;
  title: string;
  /** The band's name, at the wordmark's size: `PassBook` or the org name. */
  header: string;
  /** Optional 24 px image before the name (absolute URL). */
  headerMark?: string;
  /** The mascot seated on the card's top edge at the right. `base`: PUBLIC_BASE_URL. */
  buddy?: { base: string; mood: EmailMood; tier: BuddyTier };
  /** Content of the card body, already escaped. */
  body: string;
}

/** Body padding; the band's left text inset matches it, like the hosted card. */
const PAD = 24;
const FOIL = 2;
/** The page's gutter beside the column, and the column's width. */
const GUTTER = 16;
const COLUMN = 480;

/**
 * Shared by the sign-in and pass emails, laid out as the hosted card (src/worker/ssr/hosted.ts):
 * the band on the page (wordmark left, the buddy right), then the card with its foil edge, the
 * buddy's legs over it, and the body. A fluid 480 px column.
 */
export function emailShell(input: ShellInput): string {
  const c = EMAIL_LIGHT;
  const r = T.radius.xl;
  const art = input.buddy ? { ...EMAIL_BUDDY[input.buddy.tier], ...input.buddy } : null;
  const lineHeight = T.text.xl.line;
  const name = `${type('xl')};mso-line-height-rule:exactly;font-weight:${T.weight.semibold};letter-spacing:${T.tracking};color:${c.strong}`;
  // A long name wraps beside the mark, which stays on its first line, not under it.
  const wordmark = input.headerMark
    ? `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td valign="top" style="padding:2px 10px 0 0;vertical-align:top;font-size:0;line-height:0"><img src="${escapeHtml(input.headerMark)}" alt="" width="24" height="24" style="display:block;width:24px;height:24px;border:0;border-radius:${T.radius.md}px"></td><td class="e-strong" style="${name}">${escapeHtml(input.header)}</td></tr></table>`
    : escapeHtml(input.header);
  // The pocket's ink lines up with the body inset; the name's first line with the buddy's face.
  // Alone, the band is the hosted 56 px.
  const inset = art ? PAD - art.clear : 0;
  const band = art
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td class="e-strong" valign="bottom" style="padding:0 0 ${art.face - lineHeight / 2}px ${PAD + 1}px;${name};vertical-align:bottom">${wordmark}</td><td valign="bottom" align="right" width="${art.width}" style="width:${art.width}px;padding:0 ${inset}px 0 0;vertical-align:bottom;font-size:0;line-height:0">${buddySliceHtml(art.base, art.tier, art.mood, 'top')}</td></tr></table>`
    : `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td class="e-strong" style="padding:14px 0 14px ${PAD + 1}px;${name}">${wordmark}</td></tr></table>`;
  const gradient = `background-image:linear-gradient(115deg,${c.foil1},${c.foil2} 55%,${c.foil3});background-size:100% ${FOIL}px;background-repeat:no-repeat;border-radius:${r}px ${r}px 0 0`;
  // The foil: a gradient where clients draw one, else the first foil colour (Outlook). Under the
  // buddy the row is the legs' height, so Outlook gets a 2 px row of its own above it.
  const msoFoil = `<!--[if mso]><tr><td height="${FOIL}" bgcolor="${c.foil1}" style="height:${FOIL}px;background:${c.foil1};font-size:0;line-height:${FOIL}px;mso-line-height-rule:exactly">&nbsp;</td></tr><![endif]-->`;
  const seam = art
    ? `${msoFoil}<tr><td class="e-seam" align="right" valign="top" style="height:${art.legs}px;padding:0 ${inset - 1}px 0 0;background-color:${c.card};${gradient};font-size:0;line-height:0">${buddySliceHtml(art.base, art.tier, art.mood, 'legs')}</td></tr>`
    : `<tr><td class="e-seam" height="${FOIL}" style="height:${FOIL}px;background-color:${c.foil1};${gradient};font-size:0;line-height:${FOIL}px;mso-line-height-rule:exactly">&nbsp;</td></tr>`;
  const top = art ? PAD - art.legs : PAD - FOIL;
  // Outlook ignores max-width: a fixed ghost table holds the column there.
  return `<!doctype html>
<html lang="${escapeHtml(input.lang)}" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(input.title)}</title>
${MSO_HEAD}
<style>${DARK_CSS}</style>
</head>
<body class="e-page" style="margin:0;padding:0;background:${c.page};color:${c.text};font-family:${FONT};-webkit-text-size-adjust:100%;text-size-adjust:100%">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="${c.page}" class="e-page" style="background:${c.page}">
<tr><td align="center" style="padding:${PAD}px ${GUTTER}px">
<!--[if mso]><table role="presentation" width="${COLUMN}" align="center" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:${COLUMN}px">
<tr><td>${band}</td></tr>
<tr><td>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="${c.card}" class="e-card" style="width:100%;background:${c.card};border:1px solid ${c.line};border-top:0;border-radius:${r}px;border-collapse:separate;overflow:hidden">
${seam}
<tr><td class="e-text" style="padding:${top}px ${PAD}px ${PAD}px;color:${c.text};font-family:${FONT};border-radius:0 0 ${r}px ${r}px">
${input.body}
</td></tr>
</table>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
