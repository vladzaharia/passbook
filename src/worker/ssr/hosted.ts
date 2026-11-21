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
import { appPageHead, documentStart, type PageTheme } from './head.ts';
import { HOSTED_ART_CSS, type HostedArt, stateArtHtml } from './hosted-art.tsx';
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
.hosted{display:flex;flex-direction:column;justify-content:center;min-height:calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom));width:100%;max-width:24rem;margin:0 auto;padding:2rem 0 2.5rem}
.band{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;padding-inline:calc(1px + 1.5rem) calc(1.5rem - 19px)}
.brand{display:flex;align-items:center;height:72px}
.band .mark{gap:.625rem;font-size:1.25rem;line-height:1.75rem;letter-spacing:-.015em}
.band .mark>svg{width:1.5rem;height:1.5rem}
.scene{position:relative;z-index:2;flex:none;width:128px;height:96px;margin-bottom:0;pointer-events:none}
.scene .wl-art{width:128px;height:96px}
.scene>[data-replay]{display:block}
.hosted.wide{max-width:32rem}
.card{position:relative;z-index:1;display:flex;flex-direction:column;width:100%;overflow:hidden;border:1px solid var(--pk-border-subtle);border-radius:var(--pk-radius-xl);background:var(--pk-surface-raised);box-shadow:var(--pk-elevation-1)}
.card::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:var(--wl-foil)}
.body{display:flex;flex-direction:column;gap:1.5rem;padding:1.25rem}
h1{margin:0;overflow-wrap:break-word;font-size:var(--pk-font-size-2xl);line-height:var(--pk-line-height-2xl);font-weight:var(--pk-font-weight-semibold);letter-spacing:var(--pk-tracking-tight);color:var(--pk-text-strong)}
.lede{margin:.25rem 0 0;font-size:.875rem;line-height:1.25rem;color:var(--pk-text-muted);overflow-wrap:anywhere}
.lede b{font-weight:500;color:var(--pk-text-strong)}
.stack{display:flex;flex-direction:column;gap:1rem;margin:0}
.callout{margin:0}
label{display:block;margin:0 0 .5rem}
input:not([type="hidden"]){display:block}
.foot{display:flex;align-items:flex-start;gap:.5rem;margin:0;padding:1rem 1.25rem;border-top:1px solid var(--pk-border-subtle);font-size:.875rem;line-height:1.25rem;color:var(--pk-text-muted)}
.foot svg{flex:none;width:1rem;height:1rem;margin-top:.125rem}
@media(min-width:40rem){.hosted{padding-top:3.5rem}.body{padding:1.5rem}.foot{padding:1rem 1.5rem}}
@media(max-width:39.99rem){.band{padding-inline:calc(1px + 1.25rem) calc(1.25rem - 17px)}.brand{height:63px}.scene{margin-bottom:0}.scene,.scene .wl-art{width:112px;height:84px}}`;

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
  const lede = input.lede ? `<p class="lede">${input.lede}</p>` : '';
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
  return `${documentStart(input.theme)}${appPageHead(input.headTitle ?? input.title, { manifest: input.headTitle === undefined })}${refresh}<title>${escapeHtml(input.headTitle ?? input.title)} · ${escapeHtml(suffix)}</title><style nonce="${input.nonce}">${HOSTED_CSS}${sheet}${input.css ?? ''}</style>${input.head ?? ''}</head><body><main class="hosted${input.wide ? ' wide' : ''}"><div class="band"><div class="brand">${brand ? orgLogoHtml(brand) : wordmarkHtml()}</div><div class="scene" aria-hidden="true">${art}</div></div><section class="card" data-state="${input.art}"><div class="body"><div><h1>${escapeHtml(input.title)}</h1>${lede}</div>${error}${input.body}</div>${footer}</section>${orgMarkHtml(brand)}</main>${input.replay === false ? '' : REPLAY_SCRIPT}${input.after ?? ''}</body></html>`;
}
