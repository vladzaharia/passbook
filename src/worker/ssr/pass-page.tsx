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
import addCss from '../../web/portal/add/add.css?raw';
import { passHeading } from '../../web/portal/add/heading.ts';
import { HolderHeading } from '../../web/portal/holder-heading.tsx';
import { PortalLink } from '../../web/portal/holder-parts.tsx';
import holderPassCss from '../../web/portal/holder-pass.css?raw';
import { HolderPassView, type HolderSupport } from '../../web/portal/holder-pass-view.tsx';
import artBase from '../../web/ui/art/art.css?raw';
import artWallet from '../../web/ui/art/art-wallet.css?raw';
import common from '../../web/ui/art/scenes/common.css?raw';
import nudge from '../../web/ui/art/scenes/nudge.css?raw';
import rest from '../../web/ui/art/scenes/rest.css?raw';
import tear from '../../web/ui/art/scenes/tear.css?raw';
import walletStates from '../../web/ui/art/wallet-states.css?raw';
import { GO_TO_MY_PASSES } from './error-page.tsx';
import { documentStart, type PageTheme } from './head.ts';
import { actionHtml, hostedPage, REPLAY_SCRIPT } from './hosted.ts';
import { OrgBar } from './org-bar.tsx';
import { THEME_CSS } from './theme.ts';

/**
 * The SSR base sheet, then the SPA's preflight and the utilities /p's markup names
 * (ssr-holder.css), then the card's, the buddy's (its art, the nudge on the add block, the tear on
 * a voided notice) and the holder page's own sheets, as the SPA's cascade orders them. The body
 * loses the hosted pages' padding: the header and main pad themselves, like AppShell. Without
 * script, pressing the badge dips the card in CSS (the portal sets `dip`).
 */
const ART = [artBase, artWallet, walletStates, rest, common, nudge, tear].join('\n');
export const PAGE_CSS = `${THEME_CSS}${holderCss}${cardBase}\n${cardPoster}\n${cardText}\n${stageCss}\n${stageMotion}\n${stageSeg}\n${ART}\n${holderPassCss}\n${addCss}
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

/** What the pass is, split at the org (the portal's header says the same). */
const headingOf = (props: PassPageProps) =>
  passHeading(
    props.view.description,
    [props.view.organizationName, props.orgLabel],
    props.passTitle,
  );

/**
 * The org's bar (AppShell's: 56 px with its border, sticky, page surface), then the portal's
 * header and HolderPassView. The org leads; the platform's wordmark never shows.
 */
function PassBody(props: PassPageProps) {
  const { view } = props;
  const voided = props.voided || view.voided;
  const state = voided ? 'voided' : view.expired ? 'expired' : 'active';
  const active = state === 'active';
  const icon = view.images.icon;
  return (
    <div className="flex min-h-dvh flex-col [--wl-gutter:1rem] sm:[--wl-gutter:1.5rem]">
      <OrgBar orgName={props.orgName} icon={icon} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-safe pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <HolderHeading
          heading={headingOf(props)}
          icon={icon}
          actions={<PortalLink href={props.portalHref} />}
        />
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
  // The tab says what the pass is, as the portal's does; never the holder.
  const title = headingOf(props).title;
  const tilt = active ? '<script src="/pass-tilt.js" defer></script>' : '';
  const line = voided
    ? HOLDER_COPY.voided
    : active
      ? HOLDER_COPY.previewActive
      : HOLDER_COPY.expired;
  return `${documentStart(props.theme)}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">${previewHead(props.orgLabel, line)}<title>${escapeHtml(title)}</title>${tilt}${REPLAY_SCRIPT}<style nonce="${props.nonce}">${PAGE_CSS}</style></head><body>${renderToStaticMarkup(<PassBody {...props} />)}</body></html>`;
}

/**
 * An unknown, rotated or expired link: the hosted card with one way on, outline as every way back
 * on the hosted pages: My passes (sign-in first when needed).
 */
export function renderNotFoundPage(nonce: string, theme?: PageTheme): string {
  return hostedPage({
    nonce,
    theme,
    title: HOLDER_COPY.deadLinkTitle,
    art: 'expired',
    lede: escapeHtml(HOLDER_COPY.deadLinkLine),
    body: actionHtml(GO_TO_MY_PASSES),
  });
}
