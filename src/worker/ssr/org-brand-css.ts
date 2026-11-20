import { EMAIL_TOKENS as T } from '../../generated/resolved-tokens.ts';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import { contrast, parseColor, type Rgb } from '../../shared/pass-view/color.ts';
import markCss from '../../web/ui/layout/brand-mark.css?raw';

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** The accent's text colour: white or black, whichever reads better on it. */
export function accentOn(accent: Rgb): string {
  return contrast(accent, WHITE) >= contrast(accent, BLACK) ? '#ffffff' : '#000000';
}

/** The accent as a custom-property block for one theme, or null when it must not be used there. */
function themeRule(hex: string, page: string, fallback: { fg: string }): string {
  const accent = parseColor(hex);
  const bg = parseColor(page);
  if (!accent || !bg) return '';
  // Fills carry their own text colour; link text must reach 4.5:1 on the page, else the platform's.
  const fg = contrast(accent, bg) >= 4.5 ? hex : fallback.fg;
  return `--pk-accent:${hex};--pk-accent-on:${accentOn(accent)};--pk-accent-fg:${fg}`;
}

/**
 * The org's accent through the kit's own tokens, so every control and link follows it. A colour
 * that would vanish against a theme's page (under 3:1) is left off in that theme.
 */
export function brandCss(brand: Pick<OrgBrand, 'accent'> | undefined): string {
  const hex = brand?.accent;
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return '';
  const light = themeRule(hex, T.light.page, { fg: T.light.accentFg });
  const dark = contrastOk(hex, T.dark.page)
    ? themeRule(hex, T.dark.page, { fg: T.dark.accentFg })
    : `--pk-accent:${T.dark.accent};--pk-accent-on:${T.dark.accentOn};--pk-accent-fg:${T.dark.accentFg}`;
  // The kit's own tokens sit in media-scoped and stamped blocks, so each theme needs the same shape.
  return `:root{${light}}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]){${light}}}
:root[data-theme="light"]{${light}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}
:root[data-theme="dark"]{${dark}}`;
}

function contrastOk(hex: string, page: string): boolean {
  const a = parseColor(hex);
  const b = parseColor(page);
  return Boolean(a && b && contrast(a, b) >= 3);
}

/** Shell pieces shared by every page that carries the org's bar, logo or mark. */
export const ORG_SHELL_CSS = `.brand{min-width:0}
.org-logo{display:block;height:auto;max-width:100%;object-fit:contain}
.org-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:1.25rem;line-height:1.75rem;font-weight:600;letter-spacing:-.015em;color:var(--pk-text-strong)}
.org-mark{display:flex;align-items:center;justify-content:center;gap:.375rem;padding:1rem 1rem calc(1.25rem + env(safe-area-inset-bottom));font-size:.75rem;line-height:1rem;color:var(--pk-text-muted)}
.org-mark b{display:inline-flex;align-items:center;gap:.25rem;font-weight:600;color:var(--pk-text-strong)}
.org-mark svg{width:1rem;height:1rem;color:var(--pk-accent-fg)}
@media print{.org-mark{display:none}}
${markCss}`;
