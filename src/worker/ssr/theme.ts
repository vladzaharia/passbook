import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import controlsCss from '../../generated/ssr-controls.css?raw';
import tokensCss from '../../generated/ssr-tokens.css?raw';
import markCss from '../../web/ui/layout/brand-mark.css?raw';
import { BrandMark } from '../../web/ui/layout/brand-mark.tsx';

/**
 * The SSR pages' base sheet: the SPA's fonts and tokens (ssr-tokens.css), its base layer, then the
 * kit's controls (ssr-controls.css), all generated from the SPA's own sources by `npm run gen`.
 * A stamped data-theme (the SPA's theme cookie, ssrTheme) picks a scheme; else the OS does.
 */
export const THEME_CSS = `${tokensCss}
*,::before,::after{box-sizing:border-box}
html{font-family:var(--pk-font-sans);-webkit-text-size-adjust:100%}
@supports (font:-apple-system-body) and (-webkit-touch-callout:none){html{font:-apple-system-body;font-family:var(--pk-font-sans)}}
body{margin:0;min-height:100dvh;background:var(--pk-surface-page);color:var(--pk-text-default);font-size:.875rem;line-height:1.5;padding:env(safe-area-inset-top) max(1rem,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(1rem,env(safe-area-inset-left))}
a{color:var(--pk-accent-fg)}
:focus-visible{outline:2px solid var(--pk-focus);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
button,input{margin:0;font:inherit;color:inherit}
button{border:0;background:none;cursor:pointer}
.btn{width:100%;text-decoration:none}
@keyframes wl-rise{from{opacity:0;transform:translateY(var(--wl-rise))}}
${controlsCss}`;

/** The md Wordmark's box (wordmark.tsx; parity in ssr-parity.test.ts) plus the mark's own sheet. */
export const WORDMARK_CSS = `.mark{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-width:2rem;min-height:2rem;border-radius:var(--pk-radius-md);font-size:var(--pk-font-size-base);line-height:var(--pk-line-height-base);font-weight:var(--pk-font-weight-semibold);color:var(--pk-text-strong);text-decoration:none}
.mark>svg{width:1.25rem;height:1.25rem;color:var(--pk-accent-fg)}
@media(pointer:coarse){.mark{min-width:2.75rem;min-height:2.75rem}}
${markCss}`;

const MARK = renderToStaticMarkup(createElement(BrandMark));

/** Same wordmark as the console, as static markup. No hello on SSR pages; it smiles on hover. */
export const wordmarkHtml = (href = '/') => `<a class="mark" href="${href}">${MARK}PassBook</a>`;

export { escapeHtml } from '../../shared/html.ts';
