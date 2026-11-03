/**
 * Head tags for the SSR pages. The SPA's are in index.html and the install metadata in
 * public/manifest.webmanifest; tools/site-meta.test.ts keeps the three in step. The icons come
 * from tools/build-icons.ts.
 */
import { THEME_COLOR } from '../../generated/resolved-tokens.ts';
import { escapeHtml } from '../../shared/html.ts';

export const APP_NAME = 'PassBook';
/** One line for search results, link previews and the install sheet. */
export const APP_DESCRIPTION = 'Your Apple Wallet passes, ready to add.';

/** The ICO is for browsers without SVG icons; `sizes` stops Chrome picking it over the SVG. */
const ICONS =
  '<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';

/**
 * The visitor's theme choice: the SPA writes `wallet-theme=system|light|dark` (lib/theme.tsx).
 * Light or dark stamps the page; system, none or anything else follows the OS.
 */
export type PageTheme = 'light' | 'dark' | undefined;

export const THEME_COOKIE = 'wallet-theme';

export function themeFromCookie(header: string | null | undefined): PageTheme {
  for (const part of (header ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === THEME_COOKIE) return value === 'light' || value === 'dark' ? value : undefined;
  }
  return undefined;
}

/** Media-query metas follow the OS; a stamped theme gets one of each. */
function schemeMetas(theme: PageTheme): string {
  if (theme) {
    return `<meta name="color-scheme" content="${theme}"><meta name="theme-color" content="${THEME_COLOR[theme]}">`;
  }
  return `<meta name="color-scheme" content="light dark"><meta name="theme-color" content="${THEME_COLOR.light}" media="(prefers-color-scheme: light)"><meta name="theme-color" content="${THEME_COLOR.dark}" media="(prefers-color-scheme: dark)">`;
}

/** Every SSR page's head start; the caller adds robots, the previews, the title and the style. */
export const headHtml = (theme?: PageTheme) =>
  `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${schemeMetas(theme)}<meta name="format-detection" content="telephone=no">${ICONS}`;

/** The OS-following head (no theme chosen). */
export const HEAD_HTML = headHtml();

/** `<!doctype html><html …><head>` plus the shared head tags, with the theme stamped when chosen. */
export const documentStart = (theme?: PageTheme) =>
  `<!doctype html><html lang="en"${theme ? ` data-theme="${theme}"` : ''}><head>${headHtml(theme)}`;

/**
 * Auth and error pages: never indexed. They belong to the app, so they link the manifest. The
 * preview text is fixed: the page body can hold the visitor's email.
 */
export function appPageHead(title: string): string {
  return `<meta name="robots" content="noindex, nofollow"><meta name="description" content="${APP_DESCRIPTION}"><link rel="manifest" href="/manifest.webmanifest"><meta name="apple-mobile-web-app-title" content="${APP_NAME}"><meta property="og:site_name" content="${APP_NAME}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${APP_DESCRIPTION}">`;
}

/** This request's page theme, from its cookie header. */
export const requestTheme = (c: { req: { header(name: string): string | undefined } }) =>
  themeFromCookie(c.req.header('cookie'));
