/** Token values from @polaris-key/brand plus the wallet teal accent; SSR pages cannot import the app CSS. */
export const THEME_CSS = `@font-face{font-family:Rubik;font-style:normal;font-weight:300 900;font-display:swap;src:url(/fonts/rubik-var-latin.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
:root{color-scheme:light;--page:#f6f8ff;--raised:#fff;--sunken:#ebeef8;--strong:#060912;--fg:#262d40;--muted:#48536b;--line:#dadee9;--line-strong:#7e8699;--accent:#0f766e;--accent-on:#fff;--danger:#be2323;--danger-subtle:#f0e3e9;--warn:#814d00;--warn-subtle:#fdf0c8;--warn-line:#a15c07;--focus:#0f766e}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--page:#060912;--raised:#0d111b;--sunken:#020408;--strong:#fff;--fg:#dbe4ff;--muted:#b5bed3;--line:#212633;--line-strong:#61697b;--accent:#2dd4bf;--accent-on:#04201c;--danger:#f2513f;--danger-subtle:#221217;--warn:#c38d18;--warn-subtle:#1d1913;--warn-line:#896100;--focus:#5eead4}}
:root[data-theme=dark]{color-scheme:dark;--page:#060912;--raised:#0d111b;--sunken:#020408;--strong:#fff;--fg:#dbe4ff;--muted:#b5bed3;--line:#212633;--line-strong:#61697b;--accent:#2dd4bf;--accent-on:#04201c;--danger:#f2513f;--danger-subtle:#221217;--warn:#c38d18;--warn-subtle:#1d1913;--warn-line:#896100;--focus:#5eead4}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--page);color:var(--fg);font:14px/1.5 Rubik,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.top{display:flex;align-items:center;justify-content:space-between;height:3.5rem;padding:0 1rem}
.tbtn{display:inline-flex;align-items:center;justify-content:center;width:2.25rem;height:2.25rem;padding:0;border:0;border-radius:.375rem;background:transparent;color:var(--muted);cursor:pointer}
.tbtn:hover{background:var(--sunken);color:var(--strong)}
.tbtn svg{width:1.25rem;height:1.25rem;display:none}
.tbtn .t-system{display:block}
html[data-theme-pref=light] .tbtn svg,html[data-theme-pref=dark] .tbtn svg{display:none}
html[data-theme-pref=light] .tbtn .t-light,html[data-theme-pref=dark] .tbtn .t-dark{display:block}
.mark{display:inline-flex;align-items:center;gap:.5rem;min-height:2rem;font-size:1rem;font-weight:600;color:var(--strong);text-decoration:none}
.mark svg{width:1.25rem;height:1.25rem;color:var(--accent)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}`;

const ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11h3.75a2 2 0 0 1 1.6.8l.45.6a4 4 0 0 0 6.4 0l.45-.6a2 2 0 0 1 1.6-.8H21"/><path d="M3 7h18"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';

/** Same wordmark as the console, as static markup. */
export const wordmarkHtml = (href = '/') => `<a class="mark" href="${href}">${ICON}Wallet</a>`;

const SVG =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="';
/** Cycles system, light, dark; the script is an external file because the CSP forbids inline. */
export const themeToggleHtml = `<button class="tbtn" type="button" id="theme-toggle" aria-label="Theme: System">${SVG}t-system"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>${SVG}t-light"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>${SVG}t-dark"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></button><script src="/ssr-theme.js" defer></script>`;
/** Applies the stored theme before first paint. */
export const themeInitHtml = '<script src="/theme-init.js"></script>';
