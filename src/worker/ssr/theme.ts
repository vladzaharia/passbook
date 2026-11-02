/** The brand spring (pk-ease-spring). */
export const SPRING =
  'linear(0,0.009,0.035 2.1%,0.141 4.4%,0.723 12.9%,0.938 16.7%,1.017 20.5%,1.043 24.5%,1.035 28.4%,1.007 36%,0.998 42.4%,1)';

const LIGHT =
  '--page:#f6f8ff;--raised:#fff;--sunken:#ebeef8;--field:#fff;--strong:#060912;--fg:#262d40;--muted:#48536b;--line:#dadee9;--line-strong:#7e8699;--hover:rgb(6 9 18/.05);--accent:#0f766e;--accent-hover:#2f857e;--accent-on:#fff;--danger:#be2323;--danger-line:#db423c;--danger-subtle:#f0e3e9;--warn:#814d00;--warn-subtle:#fdf0c8;--warn-line:#a15c07;--focus:#0f766e;--foil-1:#0f766e;--foil-2:#7a2fff;--foil-3:#d07a00;--edge:transparent;--shadow:0 1px 2px 0 rgb(6 9 18/.06)';
const DARK =
  'color-scheme:dark;--page:#060912;--raised:#0d111b;--sunken:#020408;--field:#020408;--strong:#fff;--fg:#dbe4ff;--muted:#b5bed3;--line:#212633;--line-strong:#61697b;--hover:rgb(255 255 255/.06);--accent:#2dd4bf;--accent-hover:#4cdbc9;--accent-on:#04201c;--danger:#f2513f;--danger-line:#c83b2c;--danger-subtle:#221217;--warn:#c38d18;--warn-subtle:#1d1913;--warn-line:#896100;--focus:#5eead4;--foil-1:#2dd4bf;--foil-2:#9a5cff;--foil-3:#ffc24d;--edge:rgb(255 255 255/.05);--shadow:0 1px 2px 0 rgb(0 0 0/.4)';

/**
 * Token values from @polaris-key/brand plus the Wallet teal; SSR pages cannot import the app CSS.
 * Holder pages follow the system appearance: no toggle, no stored theme.
 */
export const THEME_CSS = `@font-face{font-family:Rubik;font-style:normal;font-weight:300 900;font-display:swap;src:url(/fonts/rubik-var-latin.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
:root{color-scheme:light;${LIGHT}}
@media(prefers-color-scheme:dark){:root{${DARK}}}
@media(prefers-contrast:more){:root{--muted:#333b50;--line:#7e8699}}
@media(prefers-contrast:more) and (prefers-color-scheme:dark){:root{--muted:#c3cbe0;--line:#61697b}}
*{box-sizing:border-box}
html{font-family:Rubik,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
@supports (font:-apple-system-body){html{font:-apple-system-body;font-family:Rubik,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}}
body{margin:0;min-height:100dvh;background:var(--page);color:var(--fg);font-size:.875rem;line-height:1.5;-webkit-text-size-adjust:100%;padding:env(safe-area-inset-top) max(1rem,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(1rem,env(safe-area-inset-left))}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.mark{display:inline-flex;align-items:center;gap:.5rem;min-height:2rem;border-radius:.375rem;font-size:1rem;font-weight:600;color:var(--strong);text-decoration:none}
.mark svg{width:1.25rem;height:1.25rem;color:var(--accent)}
@media(pointer:coarse){.mark{min-height:2.75rem}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;width:100%;min-height:2.75rem;padding:.5rem 1.5rem;border:1px solid transparent;border-radius:.375rem;background:var(--accent);color:var(--accent-on);font:inherit;font-size:.875rem;font-weight:500;line-height:1.25rem;text-align:center;text-decoration:none;cursor:pointer}
.btn:hover{background:var(--accent-hover)}
.btn.outline{border-color:var(--line-strong);background:transparent;color:var(--fg)}
.btn.outline:hover{background:var(--hover);color:var(--strong)}
.btn svg{width:1rem;height:1rem;flex:none}
@keyframes wl-rise{from{opacity:0;transform:translateY(8px)}}
@media (prefers-reduced-motion:no-preference){.btn{transition:background-color 120ms,color 120ms,transform 80ms}.btn:active{transform:scale(.98)}}`;

const ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11h3.75a2 2 0 0 1 1.6.8l.45.6a4 4 0 0 0 6.4 0l.45-.6a2 2 0 0 1 1.6-.8H21"/><path d="M3 7h18"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';

/** Same wordmark as the console, as static markup. Never flips on SSR pages. */
export const wordmarkHtml = (href = '/') => `<a class="mark" href="${href}">${ICON}Wallet</a>`;

/** Head tags every holder page carries (the caller adds the nonce'd style). */
export const HEAD_HTML =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="format-detection" content="telephone=no"><meta name="theme-color" content="#f6f8ff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#060912" media="(prefers-color-scheme: dark)"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';

export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
