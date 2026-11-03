import { EMAIL_TOKENS as T } from '../../generated/resolved-tokens.ts';
import { escapeHtml } from '../../shared/html.ts';
import { buddySliceHtml, EMAIL_BUDDY, type EmailMood } from './buddy.ts';

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
}`;

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

export interface ShellInput {
  lang: string;
  title: string;
  /** The band's name, at the wordmark's size: `PassBook` or the org name. */
  header: string;
  /** Optional 24 px image before the name (absolute URL). */
  headerMark?: string;
  /** The mascot seated on the card's top edge at the right. `base`: PUBLIC_BASE_URL. */
  buddy?: { base: string; mood: EmailMood };
  /** Content of the card body, already escaped. */
  body: string;
}

/** Body padding; the band's left text inset matches it, like the hosted card. */
const PAD = 24;
const FOIL = 2;
/** The pocket's ink ends 20 px inside the art's right edge, so it lines up with the body inset. */
const ART_RIGHT_SPACE = 20;

/**
 * Shared by the sign-in and pass emails, laid out as the hosted card (src/worker/ssr/hosted.ts):
 * the band on the page (wordmark left, the buddy right), then the card with its foil edge, the
 * buddy's legs over it, and the body. A fluid 480 px column.
 */
export function emailShell(input: ShellInput): string {
  const c = EMAIL_LIGHT;
  const r = T.radius.xl;
  const mark = input.headerMark
    ? `<img src="${escapeHtml(input.headerMark)}" alt="" width="24" height="24" style="display:inline-block;width:24px;height:24px;border:0;border-radius:${T.radius.md}px;vertical-align:-5px;margin-right:10px">`
    : '';
  const buddy = input.buddy;
  const name = `${type('xl')};font-weight:${T.weight.semibold};letter-spacing:${T.tracking};color:${c.strong}`;
  // The wordmark's centre lines up with the buddy's face, 28 px above the card; alone, the band is
  // the hosted 56 px.
  const inset = PAD - ART_RIGHT_SPACE;
  const band = buddy
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td class="e-strong" valign="bottom" style="padding:0 0 14px ${PAD + 1}px;${name};vertical-align:bottom">${mark}${escapeHtml(input.header)}</td><td valign="bottom" align="right" width="${EMAIL_BUDDY.width}" style="width:${EMAIL_BUDDY.width}px;padding:0 ${inset}px 0 0;vertical-align:bottom;font-size:0;line-height:0">${buddySliceHtml(buddy.base, buddy.mood, 'top')}</td></tr></table>`
    : `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td class="e-strong" style="padding:14px 0 14px ${PAD + 1}px;${name}">${mark}${escapeHtml(input.header)}</td></tr></table>`;
  const foil = `background-color:${c.card};background-image:linear-gradient(115deg,${c.foil1},${c.foil2} 55%,${c.foil3});background-size:100% ${FOIL}px;background-repeat:no-repeat;border-radius:${r}px ${r}px 0 0`;
  // The seam row: the foil along its top, the buddy's legs and shadow over it, flush with the band.
  const seam = buddy
    ? `<tr><td class="e-seam" align="right" valign="top" style="height:${EMAIL_BUDDY.legs}px;padding:0 ${inset - 1}px 0 0;${foil};font-size:0;line-height:0">${buddySliceHtml(buddy.base, buddy.mood, 'legs')}</td></tr>`
    : `<tr><td class="e-seam" style="height:${FOIL}px;${foil};font-size:0;line-height:0">&nbsp;</td></tr>`;
  const top = buddy ? PAD - EMAIL_BUDDY.legs : PAD - FOIL;
  return `<!doctype html>
<html lang="${escapeHtml(input.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(input.title)}</title>
<style>${DARK_CSS}</style>
</head>
<body class="e-page" style="margin:0;padding:0;background:${c.page};color:${c.text};font-family:${FONT}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="e-page" style="background:${c.page}">
<tr><td align="center" style="padding:${PAD}px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:480px">
<tr><td>${band}</td></tr>
<tr><td>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="e-card" style="width:100%;background:${c.card};border:1px solid ${c.line};border-top:0;border-radius:${r}px;border-collapse:separate;overflow:hidden">
${seam}
<tr><td class="e-text" style="padding:${top}px ${PAD}px ${PAD}px;color:${c.text};font-family:${FONT};border-radius:0 0 ${r}px ${r}px">
${input.body}
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
