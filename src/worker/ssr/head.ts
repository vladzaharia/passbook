/**
 * Head tags for the SSR pages. The SPA's are in index.html and the install metadata in
 * public/manifest.webmanifest; tools/site-meta.test.ts keeps the three in step. The icons come
 * from tools/build-icons.ts.
 */
import { escapeHtml } from '../../shared/html.ts';

export const APP_NAME = 'PassBook';
/** One line for search results, link previews and the install sheet. */
export const APP_DESCRIPTION = 'Your Apple Wallet passes, ready to add.';

/** The ICO is for browsers without SVG icons; `sizes` stops Chrome picking it over the SVG. */
const ICONS =
  '<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';

/** Every SSR page; the caller adds robots, the preview tags, the title and the nonce'd style. */
export const HEAD_HTML = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="format-detection" content="telephone=no"><meta name="theme-color" content="#f6f8ff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#060912" media="(prefers-color-scheme: dark)">${ICONS}`;

/**
 * Auth and error pages: never indexed. They belong to the app, so they link the manifest. The
 * preview text is fixed: the page body can hold the visitor's email.
 */
export function appPageHead(title: string): string {
  return `<meta name="robots" content="noindex, nofollow"><meta name="description" content="${APP_DESCRIPTION}"><link rel="manifest" href="/manifest.webmanifest"><meta name="apple-mobile-web-app-title" content="${APP_NAME}"><meta property="og:site_name" content="${APP_NAME}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${APP_DESCRIPTION}">`;
}
