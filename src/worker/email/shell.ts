import { escapeHtml } from '../../shared/html.ts';

export { escapeHtml };

/** Token values for emails: inline light styles, class overrides for dark clients. */
export const EMAIL_LIGHT = {
  page: '#f6f8ff',
  card: '#ffffff',
  sunken: '#ebeef8',
  strong: '#060912',
  text: '#262d40',
  muted: '#48536b',
  line: '#dadee9',
  accent: '#0f766e',
  accentOn: '#ffffff',
};

/** Static only: no @keyframes, no GIFs (motion-and-expression.md, Email). */
const DARK_CSS = `:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.e-page{background:#060912!important}
.e-card{background:#0d111b!important}
.e-text{color:#dbe4ff!important}
.e-strong{color:#ffffff!important}
.e-muted,.e-muted a{color:#b5bed3!important}
.e-btn{background:#2dd4bf!important;color:#04201c!important}
.e-link{color:#2dd4bf!important}
.e-block{border-color:#61697b!important;color:#2dd4bf!important}
.e-chip{background:#020408!important;color:#ffffff!important}
}`;

export const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
export const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or near-black, whichever reads better on `bg`. */
export const textOn = (bg: string) =>
  contrast('#ffffff', bg) >= contrast(EMAIL_LIGHT.strong, bg) ? '#ffffff' : EMAIL_LIGHT.strong;

/** The org accent for links when it reaches 4.5:1 on the white card, else the token accent. */
export const linkColor = (accent: string) =>
  contrast(accent, EMAIL_LIGHT.card) >= 4.5 ? accent : EMAIL_LIGHT.accent;

/** A 44 px link block (12 × 24 padding, 20 px line). `primary` fills it; else it is outlined. */
export function buttonHtml(
  href: string,
  label: string,
  primary: boolean,
  color = EMAIL_LIGHT.accent,
) {
  const fill = primary
    ? `background:${EMAIL_LIGHT.accent};color:${EMAIL_LIGHT.accentOn}`
    : `background:transparent;color:${color};border:1px solid ${EMAIL_LIGHT.line}`;
  return `<a class="${primary ? 'e-btn' : 'e-block'}" href="${escapeHtml(href)}" style="display:inline-block;${fill};text-decoration:none;font-size:15px;font-weight:600;line-height:20px;padding:12px 24px;border-radius:8px">${escapeHtml(label)}</a>`;
}

export interface ShellInput {
  lang: string;
  title: string;
  /** Header bar label, e.g. `PassBook` or the org name. */
  header: string;
  /** Header bar colour (`#rrggbb`); the label is white or near-black by luminance. */
  headerColor: string;
  /** Optional 20 px image before the header label (absolute URL). */
  headerMark?: string;
  /** Content of the 24px padded body cell, already escaped. */
  body: string;
}

/** Foil line over the header: PassBook teal, Polaris violet, Polaris gold. No gradient support: teal. */
const FOIL = ['#2dd4bf', '#9a5cff', '#ffc24d'];
const RADIUS = 12;

/** Shared by the sign-in and pass emails: fluid 480px card, header bar, padded body. */
export function emailShell(input: ShellInput): string {
  const c = EMAIL_LIGHT;
  const ink = textOn(input.headerColor);
  const mark = input.headerMark
    ? `<img src="${escapeHtml(input.headerMark)}" alt="" width="20" height="20" style="display:inline-block;width:20px;height:20px;border:0;border-radius:5px;vertical-align:-4px;margin-right:8px">`
    : '';
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
<tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="e-card" style="width:100%;max-width:480px;background:${c.card};border-radius:${RADIUS}px;border-collapse:separate;overflow:hidden">
<tr><td style="height:3px;line-height:3px;font-size:0;background:${FOIL[0]};background-image:linear-gradient(115deg,${FOIL.join(',')});border-radius:${RADIUS}px ${RADIUS}px 0 0">&nbsp;</td></tr>
<tr><td style="background:${input.headerColor};padding:20px 24px;color:${ink};font-size:18px;line-height:24px;font-weight:600">${mark}${escapeHtml(input.header)}</td></tr>
<tr><td class="e-text" style="padding:24px;color:${c.text};border-radius:0 0 ${RADIUS}px ${RADIUS}px">
${input.body}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
