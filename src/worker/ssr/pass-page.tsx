import { renderToStaticMarkup } from 'react-dom/server';
import '../../web/pass-card/sync-barcode.ts';
import holderCss from '../../generated/ssr-holder.css?raw';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import type { DeviceInfo } from '../../shared/device.ts';
import { escapeHtml } from '../../shared/html.ts';
import type { PassView } from '../../shared/pass-view/index.ts';
import { PassCardStage } from '../../web/pass-card/index.tsx';
import cardBase from '../../web/pass-card/pass-card-base.css?raw';
import cardPoster from '../../web/pass-card/pass-card-poster.css?raw';
import cardText from '../../web/pass-card/pass-card-text.css?raw';
import stageCss from '../../web/pass-card/stage.css?raw';
import stageMotion from '../../web/pass-card/stage-motion.css?raw';
import stageSeg from '../../web/pass-card/stage-seg.css?raw';
import holderPassCss from '../../web/portal/holder-pass.css?raw';
import { HolderPassView, type HolderSupport } from '../../web/portal/holder-pass-view.tsx';
import { documentStart, type PageTheme } from './head.ts';
import { hostedPage } from './hosted.ts';
import { THEME_CSS } from './theme.ts';

/**
 * The SSR base sheet, then the SPA's preflight and the utilities /p's markup names
 * (ssr-holder.css), then the card's and the holder page's own sheets, as the SPA's cascade orders
 * them. The body loses the hosted pages' padding: the header and main pad themselves, like AppShell.
 * Without script, pressing the badge dips the card in CSS (the portal sets `dip`).
 */
const PAGE_CSS = `${THEME_CSS}${holderCss}${cardBase}\n${cardPoster}\n${cardText}\n${stageCss}\n${stageMotion}\n${stageSeg}\n${holderPassCss}
body{padding:0}
@media (prefers-reduced-motion:no-preference){.wl-holder:has([data-awb]:active) .pc-lift{animation:pc-dip 420ms cubic-bezier(.2,0,0,1)}}`;

export interface PassPageProps {
  view: PassView;
  nonce: string;
  /** The visitor's theme choice (requestTheme); undefined follows the OS. */
  theme?: PageTheme;
  /** The org's name for the header and the voided note (never the platform's). */
  orgName: string;
  /** The org record's name, for link previews and the home-screen label: never a pass field. */
  orgLabel: string;
  /** The pass's own title (display title, else its description). */
  passTitle: string;
  downloadHref: string;
  /** The absolute URL of this page: the add QR encodes it. */
  publicUrl: string;
  /** The holder's page in the portal (sign-in first when needed). */
  portalHref: string;
  voided: boolean;
  device: DeviceInfo;
  /** Org support contacts, already validated; omitted when the org has none. */
  support?: HolderSupport;
}

/**
 * The org's bar (AppShell's: 56 px with its border, sticky, page surface), then the h1 and the
 * portal's HolderPassView. The org leads; the platform's wordmark never shows.
 */
function PassBody(props: PassPageProps) {
  const { view } = props;
  const voided = props.voided || view.voided;
  const state = voided ? 'voided' : view.expired ? 'expired' : 'active';
  const active = state === 'active';
  const icon = view.images.icon;
  return (
    <div className="flex min-h-dvh flex-col [--wl-gutter:1rem] sm:[--wl-gutter:1.5rem]">
      <header className="sticky top-0 z-20 border-b border-border bg-surface-page pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-[calc(3.5rem-1px)] w-full max-w-5xl items-center gap-2.5 px-safe">
          {icon ? (
            <img
              src={icon.src}
              srcSet={icon.srcset}
              alt=""
              className="size-7 shrink-0 rounded-md object-contain"
            />
          ) : null}
          <span className="min-w-0 truncate text-base font-semibold text-fg-strong">
            {props.orgName}
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-safe pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <h1 className="mb-6 text-2xl font-semibold tracking-[-0.015em] text-fg-strong [overflow-wrap:anywhere]">
          {props.passTitle}
        </h1>
        <HolderPassView
          pass={
            <PassCardStage
              view={view}
              enter
              tilt={active}
              glow={active}
              dim={!active}
              toggleId="pc-flip"
            />
          }
          passTitle={props.passTitle}
          orgName={props.orgName}
          state={state}
          device={props.device}
          downloadHref={props.downloadHref}
          publicUrl={props.publicUrl}
          support={props.support}
          portalHref={props.portalHref}
          theme={props.theme}
          rise
        />
      </main>
    </div>
  );
}

/**
 * A shared link's preview names the org and the pass's state, never the holder or a pass field
 * (the title can carry the holder's name). No og:image or og:url: the org's art lives behind the
 * token. No manifest either: a pass saved to the home screen opens itself, not the portal.
 */
function previewHead(org: string, line: string): string {
  const label = escapeHtml(org || 'Pass');
  const title = org ? `${escapeHtml(org)} pass` : 'Pass';
  return `<meta name="description" content="${line}"><meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${line}"><meta name="apple-mobile-web-app-title" content="${label}">`;
}

export function renderPassPage(props: PassPageProps): string {
  const voided = props.voided || props.view.voided;
  const active = !voided && !props.view.expired;
  const title = `${props.passTitle} · ${props.orgName}`;
  const tilt = active ? '<script src="/pass-tilt.js" defer></script>' : '';
  const line = voided
    ? HOLDER_COPY.voided
    : active
      ? HOLDER_COPY.previewActive
      : HOLDER_COPY.expired;
  return `${documentStart(props.theme)}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">${previewHead(props.orgLabel, line)}<title>${escapeHtml(title)}</title>${tilt}<style nonce="${props.nonce}">${PAGE_CSS}</style></head><body>${renderToStaticMarkup(<PassBody {...props} />)}</body></html>`;
}

/** An unknown, rotated or expired link: the hosted card with one way on. */
export function renderNotFoundPage(nonce: string, theme?: PageTheme): string {
  return hostedPage({
    nonce,
    theme,
    title: 'Link expired',
    art: 'expired',
    lede: 'Sign in to see your passes.',
    body: '<a class="btn" href="/login">Sign in</a>',
  });
}
