export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Token values for emails: inline light styles, class overrides for dark clients. */
export const EMAIL_LIGHT = {
  page: '#f6f8ff',
  card: '#ffffff',
  strong: '#060912',
  text: '#262d40',
  muted: '#48536b',
  line: '#dadee9',
  accent: '#0f766e',
  accentOn: '#ffffff',
};

const DARK_CSS = `:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.e-page{background:#060912!important}
.e-card{background:#0d111b!important}
.e-text{color:#dbe4ff!important}
.e-strong{color:#ffffff!important}
.e-muted,.e-muted a{color:#b5bed3!important}
.e-btn{background:#2dd4bf!important;color:#04201c!important}
.e-link{color:#2dd4bf!important}
.e-well{background:#020408!important;border-color:#212633!important;color:#ffffff!important}
}`;

export const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

export interface ShellInput {
  lang: string;
  title: string;
  /** Header bar label, e.g. `Wallet` or the org name. */
  header: string;
  /** Header bar colour (`#rrggbb`). */
  headerColor: string;
  /** Content of the 24px padded body cell, already escaped. */
  body: string;
}

/** Foil line over the header: Wallet teal, Polaris violet, Polaris gold. No gradient support: teal. */
const FOIL = ['#2dd4bf', '#9a5cff', '#ffc24d'];

/** Shared by the sign-in and pass emails: fluid 480px card, header bar, padded body. */
export function emailShell(input: ShellInput): string {
  const c = EMAIL_LIGHT;
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
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="e-card" style="width:100%;max-width:480px;background:${c.card};border-radius:12px">
<tr><td style="height:3px;line-height:3px;font-size:0;background:${FOIL[0]};background-image:linear-gradient(115deg,${FOIL.join(',')});border-radius:12px 12px 0 0">&nbsp;</td></tr>
<tr><td style="background:${input.headerColor};padding:20px 24px;color:#ffffff;font-size:18px;font-weight:600">${escapeHtml(input.header)}</td></tr>
<tr><td class="e-text" style="padding:24px;color:${c.text}">
${input.body}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
