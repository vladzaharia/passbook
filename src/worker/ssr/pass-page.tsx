import { renderToStaticMarkup } from 'react-dom/server';
import '../../web/pass-card/sync-barcode.ts';
import type { PassView } from '../../shared/pass-view/index.ts';
import { PassCardStage } from '../../web/pass-card/index.tsx';
import cardBase from '../../web/pass-card/pass-card-base.css?raw';
import cardPoster from '../../web/pass-card/pass-card-poster.css?raw';
import cardText from '../../web/pass-card/pass-card-text.css?raw';
import stageCss from '../../web/pass-card/stage.css?raw';
import stageMotion from '../../web/pass-card/stage-motion.css?raw';
import stageSeg from '../../web/pass-card/stage-seg.css?raw';
import type { PassDevice } from './device.ts';
import { hostedPage } from './hosted.ts';
import { escapeHtml, HEAD_HTML, THEME_CSS } from './theme.ts';

const cardCss = `${cardBase}\n${cardPoster}\n${cardText}`;
const stageAllCss = `${stageCss}\n${stageMotion}\n${stageSeg}`;

export interface PassPageProps {
  view: PassView;
  nonce: string;
  /** The org's name for the header and h1 (never the platform's). */
  orgName: string;
  /** The pass's own title (display title, else its description). */
  passTitle: string;
  downloadHref: string;
  /** Data URI of a QR for the download URL; omitted for voided passes. */
  qrSrc: string | null;
  voided: boolean;
  device: PassDevice;
  /** An in-app browser (Google app, Facebook, Instagram, Outlook): Safari can add, it cannot. */
  inApp: boolean;
  /** Org support contacts, already validated; omitted when the org has none. */
  support?: { email: string | null; url: string | null };
}

/**
 * Apple's badge, unmodified: black on light, outline on dark (the kit's appleWalletBadgeHtml,
 * which the Worker typecheck cannot import). Never animated.
 */
const badgeHtml = (href: string) =>
  `<a class="awb" href="${escapeHtml(href)}"><picture><source srcset="/apple/badge/en/outline.svg" media="(prefers-color-scheme: dark)"><img src="/apple/badge/en/black.svg" alt="Add to Apple Wallet" height="44"></picture></a>`;

const ADD_LINE = 'Open on iPhone or Mac to add to Apple Wallet.';
const SAFARI_LINE = 'Open in Safari to add to Apple Wallet.';

const svg = (d: string) =>
  `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

/** Voided (Ban) and expired (Clock) notes; static markup. */
const NOTE_HTML = {
  voided: `<p class="note" role="status">${svg('<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>')}This pass was voided.</p>`,
  expired: `<p class="note" role="status">${svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>')}This pass has expired.</p>`,
};

const CSS = `
.pp-head{display:flex;align-items:center;gap:.625rem;min-height:3.5rem;max-width:28rem;margin:0 auto}
.pp-head img{width:1.75rem;height:1.75rem;border-radius:.375rem;object-fit:contain}
.pp-head span{min-width:0;overflow:hidden;font-size:1rem;font-weight:600;color:var(--strong);text-overflow:ellipsis;white-space:nowrap}
.pp{display:grid;grid-template-areas:"title" "pass" "actions";gap:1.5rem;max-width:28rem;margin:0 auto;padding:.5rem 0 3rem}
.pp>*{min-width:0}
.pp-title{grid-area:title;display:flex;flex-direction:column;gap:1rem}
.pp-pass{grid-area:pass;clip-path:inset(-24px)}
.pp-actions{grid-area:actions;display:flex;flex-direction:column;align-items:flex-start;gap:1rem}
h1{margin:0;font-size:1.5rem;line-height:2rem;font-weight:600;letter-spacing:-.015em;color:var(--strong);overflow-wrap:anywhere}
h1 small{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.note{display:flex;gap:.75rem;margin:0;padding:.75rem 1rem;border:1px solid var(--warn-line);border-radius:.625rem;background:var(--warn-subtle);color:var(--fg)}
.note svg{flex:none;width:1rem;height:1rem;margin-top:.1875rem;color:var(--warn)}
.badge .awb{display:block;padding:4.4px;border-radius:.5rem}
.badge img{display:block;height:44px;width:auto}
.line{margin:0;color:var(--muted)}
.ipad{display:none}
.qr{display:flex;align-items:center;gap:1rem;width:100%;margin:0;padding:1rem;border:1px solid var(--line);border-radius:.75rem;background:var(--raised);box-shadow:inset 0 1px 0 var(--edge)}
.qr img{flex:none;width:7.5rem;height:7.5rem;padding:.25rem;border-radius:.5rem;background:#fff}
.qr p{margin:0;font-weight:500;color:var(--strong)}
footer{width:100%;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);overflow-wrap:anywhere}
.pp .pc-stage{max-width:22rem}
@media (pointer:coarse){.pp-actions[data-device=mac] .qr{order:-1}.pp-actions[data-device=mac] .ipad{display:block}}
@media(min-width:64rem){
.pp-head{max-width:50rem}
.pp{grid-template-columns:22rem minmax(0,1fr);grid-template-areas:"pass title" "pass actions";grid-template-rows:auto 1fr;column-gap:4rem;row-gap:1.5rem;max-width:50rem;padding-top:2.5rem}
h1 small{position:static;display:block;width:auto;height:auto;margin-bottom:.25rem;clip-path:none;font-size:.875rem;line-height:1.25rem;font-weight:400;letter-spacing:0;color:var(--muted)}
}
@media (prefers-reduced-motion:no-preference){
.pp-title,.pp-actions>:not(.badge){animation:wl-rise 260ms cubic-bezier(0,0,0,1) 240ms backwards}
.pp-pass[data-quiet] .pc-stage{animation:wl-rise 260ms cubic-bezier(0,0,0,1) backwards}
.pp:has(.awb:active) .pc-lift{animation:pc-dip 420ms cubic-bezier(.2,0,0,1)}
}`;

function PassBody(props: PassPageProps) {
  const { view } = props;
  const voided = props.voided || view.voided;
  const notice = voided ? 'voided' : view.expired ? 'expired' : null;
  const active = notice === null;
  const icon = view.images.icon;
  const canAdd = props.device === 'iphone' || props.device === 'mac';
  const qr =
    active && props.qrSrc && props.device !== 'iphone' ? (
      <section className="qr">
        <img src={props.qrSrc} alt="QR code for the pass download" />
        <p>Scan with your iPhone.</p>
      </section>
    ) : null;
  const badge = active ? (
    <div
      className="badge"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static badge markup, href escaped
      dangerouslySetInnerHTML={{ __html: badgeHtml(props.downloadHref) }}
    />
  ) : null;
  return (
    <>
      <header className="pp-head">
        {icon ? <img src={icon.src} srcSet={icon.srcset} alt="" /> : null}
        <span>{props.orgName}</span>
      </header>
      <main className="pp">
        <div className="pp-title">
          <h1>
            <small>{props.orgName}</small>
            {props.passTitle}
          </h1>
          {notice ? (
            <div
              // biome-ignore lint/security/noDangerouslySetInnerHtml: static icon and copy
              dangerouslySetInnerHTML={{ __html: NOTE_HTML[notice] }}
            />
          ) : null}
        </div>
        <div className="pp-pass" data-quiet={active ? undefined : ''}>
          <PassCardStage
            view={view}
            enter={active}
            tilt={active}
            glow={active}
            dim={!active}
            toggleId="pc-flip"
          />
        </div>
        <div className="pp-actions" data-device={props.device}>
          {active && !canAdd ? <p className="line">{ADD_LINE}</p> : null}
          {active && props.device === 'mac' ? <p className="line ipad">{ADD_LINE}</p> : null}
          {active && props.device !== 'other' && props.inApp ? (
            <p className="line">{SAFARI_LINE}</p>
          ) : null}
          {canAdd ? badge : qr}
          {canAdd ? qr : badge}
          {props.support?.email || props.support?.url ? (
            <footer>
              Help:{' '}
              {props.support.email ? (
                <a href={`mailto:${props.support.email}`}>{props.support.email}</a>
              ) : null}
              {props.support.email && props.support.url ? ' | ' : null}
              {props.support.url ? <a href={props.support.url}>{props.support.url}</a> : null}
            </footer>
          ) : null}
        </div>
      </main>
    </>
  );
}

export function renderPassPage(props: PassPageProps): string {
  const voided = props.voided || props.view.voided;
  const active = !voided && !props.view.expired;
  const title = `${props.passTitle} · ${props.orgName}`;
  const tilt = active ? '<script src="/pass-tilt.js" defer></script>' : '';
  return `<!doctype html><html lang="en"><head>${HEAD_HTML}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>${tilt}<style nonce="${props.nonce}">${THEME_CSS}${cardCss}${stageAllCss}${CSS}</style></head><body>${renderToStaticMarkup(<PassBody {...props} />)}</body></html>`;
}

/** An unknown, rotated or expired link: the hosted card with one way on. */
export function renderNotFoundPage(nonce: string): string {
  return hostedPage({
    nonce,
    title: 'Link expired',
    art: 'expired',
    lede: 'Sign in to see your passes.',
    body: '<a class="btn" href="/login">Sign in</a>',
  });
}
