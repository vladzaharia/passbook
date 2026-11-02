/**
 * The hosted shell shared by the SSR auth and error pages. Same metrics as /login
 * (src/web/portal/login-page.tsx, login-scene.css): one header band, the 20 px wordmark at the
 * card's left text inset and the 128×96 wallet scene (112×84 under 640) seated on the card's top
 * edge at the right, then the card, so the h1 and card sit at identical positions. The art moves in
 * CSS only, once on load; one same-origin script (public/buddy-replay.js) replays its hello on a
 * click. No inline script.
 */
import { ART_CSS } from '../../web/ui/art/css.ts';
import { artHtml, HOSTED_ART_CSS, type HostedArt } from './hosted-art.tsx';
import { escapeHtml, HEAD_HTML, THEME_CSS, wordmarkHtml } from './theme.ts';

export const HOSTED_FOOTER = 'Signing in shows the passes sent to your email.';

/** Click to replay the wallet's hello; same-origin, so `script-src 'self'` covers it. */
export const REPLAY_SCRIPT = '<script src="/buddy-replay.js" defer></script>';

const LOCK =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const OCTAGON_X =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z"/><path d="m15 9-6 6M9 9l6 6"/></svg>';

export const HOSTED_CSS = `${THEME_CSS}
${ART_CSS}
${HOSTED_ART_CSS}
.hosted{display:flex;flex-direction:column;width:100%;max-width:24rem;margin:0 auto;padding:2rem 0 2.5rem}
.band{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;padding-inline:calc(1px + 1.375rem) calc(1.5rem - 19px)}
.brand{display:flex;align-items:center;height:56px}
.band .mark{gap:.625rem;font-size:1.25rem;line-height:1.75rem;letter-spacing:-.015em}
.band .mark svg{width:1.5rem;height:1.5rem}
.scene{position:relative;z-index:2;flex:none;width:128px;height:96px;margin-bottom:-8px;pointer-events:none}
.scene .wl-art{width:128px;height:96px}
.scene>[data-replay]{display:block}
.card{position:relative;z-index:1;display:flex;flex-direction:column;width:100%;overflow:hidden;border:1px solid var(--line);border-radius:1.125rem;background:var(--raised);box-shadow:inset 0 1px 0 var(--edge),var(--shadow)}
.card::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(115deg,var(--foil-1),var(--foil-2) 55%,var(--foil-3))}
.body{display:flex;flex-direction:column;gap:1.5rem;padding:1.25rem}
h1{margin:0;font-size:1.5rem;line-height:2rem;font-weight:600;letter-spacing:-.015em;color:var(--strong)}
.lede{margin:.25rem 0 0;font-size:.875rem;line-height:1.25rem;color:var(--muted);overflow-wrap:anywhere}
.lede b{font-weight:500;color:var(--strong)}
.stack{display:flex;flex-direction:column;gap:1rem;margin:0}
.callout{display:flex;gap:.75rem;margin:0;padding:.75rem 1rem;border:1px solid var(--danger-line);border-radius:.625rem;background:var(--danger-subtle);color:var(--fg);font-size:.875rem;line-height:1.25rem}
.callout svg{flex:none;width:1rem;height:1rem;margin-top:.125rem;color:var(--danger)}
label{display:block;margin:0 0 .5rem;font-size:.875rem;line-height:1.25rem;font-weight:500;color:var(--fg)}
input{display:block;width:100%;height:2.25rem;padding:0 .75rem;border:1px solid var(--line-strong);border-radius:.375rem;background:var(--field);color:var(--fg);font:inherit;font-size:.875rem}
@media (pointer:coarse){input{height:2.75rem;font-size:max(16px,1rem)}}
input:focus-visible{outline-offset:1px}
.foot{display:flex;align-items:flex-start;gap:.5rem;margin:0;padding:1rem 1.25rem;border-top:1px solid var(--line);font-size:.875rem;line-height:1.25rem;color:var(--muted)}
.foot svg{flex:none;width:1rem;height:1rem;margin-top:.125rem}
@media(min-width:40rem){.hosted{padding-top:3.5rem}.body{padding:1.5rem}.foot{padding:1rem 1.5rem}}
@media(max-width:39.99rem){.band{padding-inline:calc(1px + 1.125rem) calc(1.25rem - 17px)}.brand{height:49px}.scene{margin-bottom:-7px}.scene,.scene .wl-art{width:112px;height:84px}}`;

export type { HostedArt };

export interface HostedPageInput {
  nonce: string;
  /** `<title>` and the card's h1. */
  title: string;
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
}

export const calloutHtml = (message: string) =>
  `<p class="callout" role="alert">${OCTAGON_X}<span>${escapeHtml(message)}</span></p>`;

/** A full hosted page: the band (wordmark, wallet scene), then the card with an h1 and the body. */
export function hostedPage(input: HostedPageInput): string {
  const art = artHtml(input.art, Boolean(input.error));
  const lede = input.lede ? `<p class="lede">${input.lede}</p>` : '';
  const error = input.error ? calloutHtml(input.error) : '';
  const footer = input.footer ? `<p class="foot">${LOCK}${escapeHtml(HOSTED_FOOTER)}</p>` : '';
  return `<!doctype html><html lang="en"><head>${HEAD_HTML}<meta name="robots" content="noindex"><title>${escapeHtml(input.title)} · PassBook</title><style nonce="${input.nonce}">${HOSTED_CSS}</style></head><body><main class="hosted"><div class="band"><div class="brand">${wordmarkHtml()}</div><div class="scene" aria-hidden="true">${art}</div></div><section class="card" data-state="${input.art}"><div class="body"><div><h1>${escapeHtml(input.title)}</h1>${lede}</div>${error}${input.body}</div>${footer}</section></main>${REPLAY_SCRIPT}</body></html>`;
}
