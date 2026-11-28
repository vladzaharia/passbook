/**
 * The hosted shell shared by the SSR auth and error pages. Same metrics as /login
 * (src/web/portal/login-page.tsx, login-scene.css, login-card.tsx): one header band, the 20 px
 * wordmark at the card's left text inset and the 128×96 wallet scene (112×84 under 640) seated on
 * the card's top edge at the right, then the card, so the h1 and card sit at identical positions.
 * The art moves in CSS only, once on load; one same-origin script (public/buddy-replay.js) replays
 * its scene on a click. No inline script.
 */
import { Lock, type LucideIcon, OctagonX } from 'lucide-react';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { ART_CSS } from '../../web/ui/art/css.ts';
import hostedCardCss from '../../web/ui/hosted-card.css?raw';
import { appPageHead, documentStart, type PageTheme } from './head.ts';
import { HOSTED_ART_CSS, type HostedArt, stateArtHtml } from './hosted-art.tsx';
import { hostedCardHtml } from './hosted-card.tsx';
import { iconHtml } from './icon.ts';
import { orgLogoHtml, orgMarkHtml } from './org-bar.tsx';
import { brandCss, ORG_SHELL_CSS } from './org-brand-css.ts';
import { escapeHtml, THEME_CSS, WORDMARK_CSS, wordmarkHtml } from './theme.ts';

/** Click to replay the buddy's scene; same-origin, so `script-src 'self'` covers it. */
export const REPLAY_SCRIPT = '<script src="/buddy-replay.js" defer></script>';

/** Layout only: the controls' look comes from the kit (THEME_CSS), the card's from login-card.tsx. */
export const HOSTED_CSS = `${THEME_CSS}
${WORDMARK_CSS}
${ART_CSS}
${HOSTED_ART_CSS}
${hostedCardCss}
.band .mark{gap:.625rem;font-size:1.25rem;line-height:1.75rem;letter-spacing:-.015em}
.band .mark>svg{width:1.5rem;height:1.5rem}
.stack{display:flex;flex-direction:column;gap:1rem;margin:0}
.callout{margin:0}
label{display:block;margin:0 0 .5rem}
input:not([type="hidden"]){display:block}`;

export type { HostedArt };

export interface HostedPageInput {
  nonce: string;
  /** The visitor's theme choice (requestTheme); undefined follows the OS. */
  theme?: PageTheme;
  /** The card's h1, and the `<title>` unless `headTitle` says otherwise. */
  title: string;
  /** A capability page's tab and link-preview title, when `title` can carry a holder's name; it also drops the manifest link. */
  headTitle?: string;
  /** The scene's art and state beat (CSS only, static after load). */
  art: HostedArt;
  /** At most one short line under the h1, already escaped. */
  lede?: string;
  /** One sentence in a danger callout at the top of the card body. */
  error?: string;
  /** Card body after the h1, already escaped. */
  body: string;
  /** The lock line under the card body (sign-in pages). */
  footer?: boolean;
  /** A wider card (32 rem) for a page that shows a code; the rest of the shell is the same. */
  wide?: boolean;
  /** Sheets for this page's own body, after the shell's, and markup after the card (scripts). */
  css?: string;
  /** Extra head markup (the barcode page's referrer policy) and markup after the card. */
  head?: string;
  after?: string;
  /** False leaves out the replay script (a page that must carry no script of its own). */
  replay?: boolean;
  /** The org this page is about: its logo or name leads the band, its accent colours the page, and the mark level sets the foot. */
  brand?: OrgBrand;
  /** Moves on to this URL at once (meta refresh), as a page rather than a redirect. */
  refresh?: string;
}

/**
 * One link-styled action. Primary moves the flow on (Sign in, Confirm); a way back or a retry is
 * outline, as in the app's state boxes.
 */
export interface PageAction {
  label: string;
  /** "" reloads the page (Retry). */
  href: string;
  icon?: LucideIcon;
  primary?: boolean;
}

export const actionHtml = ({ label, href, icon, primary }: PageAction) =>
  `<a class="btn${primary ? '' : ' outline'}" href="${escapeHtml(href)}">${icon ? iconHtml(icon) : ''}${escapeHtml(label)}</a>`;

/** A POST as a button: sign-out and the one-time links' consume. */
export const postButton = (action: string, label: string, fields: Record<string, string> = {}) =>
  `<form method="post" action="${escapeHtml(action)}">${Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('')}<button class="btn" type="submit">${label}</button></form>`;

export const calloutHtml = (message: string) =>
  `<p class="callout" role="alert">${iconHtml(OctagonX)}<span>${escapeHtml(message)}</span></p>`;

/** A full hosted page: the band (wordmark, wallet scene), then the card with an h1 and the body. */
export function hostedPage(input: HostedPageInput): string {
  const art = stateArtHtml(input.art, Boolean(input.error));
  const error = input.error ? calloutHtml(input.error) : '';
  const footer = input.footer
    ? `<p class="foot">${iconHtml(Lock)}${escapeHtml(HOLDER_COPY.signInFooter)}</p>`
    : '';
  const refresh = input.refresh
    ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(input.refresh)}">`
    : '';
  const { brand } = input;
  const sheet = brand ? `${ORG_SHELL_CSS}\n${brandCss(brand)}` : '';
  const suffix = brand ? brand.name : 'PassBook';
  const card = hostedCardHtml({
    wide: input.wide,
    state: input.art,
    title: escapeHtml(input.title),
    brand: brand ? orgLogoHtml(brand) : wordmarkHtml(),
    scene: art,
    lede: input.lede,
    error,
    body: input.body,
    footer,
    after: orgMarkHtml(brand),
  });
  return `${documentStart(input.theme)}${appPageHead(input.headTitle ?? input.title, { manifest: input.headTitle === undefined })}${refresh}<title>${escapeHtml(input.headTitle ?? input.title)} · ${escapeHtml(suffix)}</title><style nonce="${input.nonce}">${HOSTED_CSS}${sheet}${input.css ?? ''}</style>${input.head ?? ''}</head><body>${card}${input.replay === false ? '' : REPLAY_SCRIPT}${input.after ?? ''}</body></html>`;
}
