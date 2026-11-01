/** Token values from @polaris-key/brand plus the wallet teal accent; SSR pages cannot import the app CSS. */
export const THEME_CSS = `:root{color-scheme:light dark;--page:#f6f8ff;--raised:#fff;--sunken:#ebeef8;--strong:#060912;--fg:#262d40;--muted:#48536b;--line:#dadee9;--line-strong:#7e8699;--accent:#0f766e;--accent-on:#fff;--danger:#be2323;--danger-subtle:#f0e3e9;--warn:#814d00;--warn-subtle:#fdf0c8;--warn-line:#a15c07;--focus:#0f766e}
@media(prefers-color-scheme:dark){:root{--page:#060912;--raised:#0d111b;--sunken:#020408;--strong:#fff;--fg:#dbe4ff;--muted:#b5bed3;--line:#212633;--line-strong:#61697b;--accent:#2dd4bf;--accent-on:#04201c;--danger:#f2513f;--danger-subtle:#221217;--warn:#c38d18;--warn-subtle:#1d1913;--warn-line:#896100;--focus:#5eead4}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--page);color:var(--fg);font:14px/1.5 Rubik,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.top{display:flex;align-items:center;height:3.5rem;padding:0 1rem}
.mark{display:inline-flex;align-items:center;gap:.5rem;min-height:2rem;font-size:1rem;font-weight:600;color:var(--strong);text-decoration:none}
.mark svg{width:1.25rem;height:1.25rem;color:var(--accent)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}`;

const ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11h3.75a2 2 0 0 1 1.6.8l.45.6a4 4 0 0 0 6.4 0l.45-.6a2 2 0 0 1 1.6-.8H21"/><path d="M3 7h18"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';

/** Same wordmark as the console, as static markup. */
export const wordmarkHtml = (href = '/') => `<a class="mark" href="${href}">${ICON}Wallet</a>`;
