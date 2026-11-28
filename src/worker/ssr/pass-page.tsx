import { WalletCards } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../web/pass-card/sync-barcode.ts';
import holderCss from '../../generated/ssr-holder.css?raw';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import type { EffectiveChannels } from '../../shared/contracts/channels.ts';
import type { Mode } from '../../shared/contracts/common.ts';
import type { WalletOffer } from '../../shared/contracts/me.ts';
import type {
  WalletProvider,
  WalletProviderIssuance,
} from '../../shared/contracts/wallet-providers.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { type DeviceInfo, MAC_REVEAL_SCRIPT } from '../../shared/device.ts';
import { escapeHtml } from '../../shared/html.ts';
import { BUNDLE_SAVE_PATH, DROP_SCRIPT, PASS_SAVE_PATH } from '../../shared/pass-offline.ts';
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
import type { EndedSignIn } from '../../web/portal/ended-card.tsx';
import { HolderHeading } from '../../web/portal/holder-heading.tsx';
import holderOthersCss from '../../web/portal/holder-others.css?raw';
import holderPassCss from '../../web/portal/holder-pass.css?raw';
import { HolderPassView, type HolderSupport } from '../../web/portal/holder-pass-view.tsx';
import { PassDetails } from '../../web/portal/pass-details.tsx';
import savePhoneCss from '../../web/portal/save-phone.css?raw';
import { doorPathOf } from '../../web/portal/save-phone.tsx';
import artBase from '../../web/ui/art/art.css?raw';
import artWallet from '../../web/ui/art/art-wallet.css?raw';
import common from '../../web/ui/art/scenes/common.css?raw';
import nudge from '../../web/ui/art/scenes/nudge.css?raw';
import rest from '../../web/ui/art/scenes/rest.css?raw';
import tear from '../../web/ui/art/scenes/tear.css?raw';
import tuck from '../../web/ui/art/scenes/tuck.css?raw';
import walletStates from '../../web/ui/art/wallet-states.css?raw';
import { documentStart, type PageTheme } from './head.ts';
import { actionHtml, hostedPage, type PageAction, REPLAY_SCRIPT } from './hosted.ts';
import { OrgBar, OrgMark } from './org-bar.tsx';
import { brandCss, ORG_SHELL_CSS } from './org-brand-css.ts';
import passPageCss from './pass-page.css?raw';
import { RIBBON_CSS, TestRibbon } from './test-ribbon.tsx';
import { THEME_CSS } from './theme.ts';

/**
 * The SSR base sheet, then the SPA's preflight and the utilities /p's markup names
 * (ssr-holder.css), then the card's, the buddy's (its art, the nudge on the add block, the tear on
 * a voided notice) and the holder page's own sheets, as the SPA's cascade orders them. The body
 * loses the hosted pages' padding: the header and main pad themselves, like AppShell. Without
 * script, pressing the badge dips the card in CSS (the portal sets `dip`).
 */
const ART = [artBase, artWallet, walletStates, rest, common, nudge, tear, tuck].join('\n');
export const PAGE_CSS = `${THEME_CSS}${holderCss}${cardBase}\n${cardPoster}\n${cardText}\n${stageCss}\n${stageMotion}\n${stageSeg}\n${ART}\n${holderPassCss}\n${holderOthersCss}\n${savePhoneCss}\n${addCss}\n${RIBBON_CSS}
${ORG_SHELL_CSS}
body{padding:0}
${passPageCss}
@media (prefers-reduced-motion:no-preference){.wl-holder:has([data-awb]:active) .pc-lift{animation:pc-dip 420ms cubic-bezier(.2,0,0,1)}}`;

export interface PassPageProps {
  view: PassView;
  /** The issued pass.json: the details list names every front field. */
  passJson: Record<string, unknown>;
  /** The request clock. */
  now: Date;
  /** The visitor's zone, for dates in the details. */
  timeZone?: string;
  nonce: string;
  /** The visitor's theme choice (requestTheme); undefined follows the OS. */
  theme?: PageTheme;
  /** The org's name for the header and the voided note (never the platform's). */
  orgName: string;
  /** The org's brand kit (`orgBrandOf`): logo, accent and mark level. */
  brand?: OrgBrand;
  /** The org record's name, for link previews and the home-screen label: never a pass field. */
  orgLabel: string;
  /** The pass's own title (display title, else its description). */
  passTitle: string;
  /** Null while Apple is off for this pass: no badge. */
  downloadHref: string | null;
  walletOffers: readonly WalletOffer[];
  /** The release gate per native wallet, when the caller has it. */
  issuance?: Partial<Record<WalletProvider, WalletProviderIssuance>>;
  /** The browser barcode page; never the QR that opens this page. */
  barcodeHref?: string | undefined;
  /** What each channel offers this holder (the one gate). */
  channels?: EffectiveChannels;
  /** The print page, when paper is on and the template lets the holder print. */
  printHref?: string;
  /** The absolute URL of this page: the add QR encodes it. */
  publicUrl: string;
  /** The holder's page in the portal (sign-in first when needed): a row of the other ways, only
   * with a holder email (resend). */
  portalHref?: string;
  /** A bundle's member page: the way back to the bundle. */
  backHref?: string;
  voided: boolean;
  /** The org removed the pass from Wallet; its note, if it wrote one. */
  removal?: { message: string | null } | null;
  /** A test pass carries a ribbon. */
  mode?: Mode;
  device: DeviceInfo;
  /** Org support contacts, already validated; omitted when the org has none. */
  support?: HolderSupport;
  /** When a voided or expired pass stopped working, formatted for the visitor. */
  endedOn?: string | null;
  /** The code changed and the holder has no email to hear it: a line above the add block. */
  notice?: string;
  /** Send it again: set when the pass has a holder email. */
  resend?: { action: string; again: 'sent' | 'wait' | null };
  /** An ended pass with a holder email: Email me my passes. */
  signin?: EndedSignIn;
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
  const state = props.removal ? 'removed' : voided ? 'voided' : view.expired ? 'expired' : 'active';
  const active = state === 'active';
  return (
    <div className="flex min-h-dvh flex-col [--wl-gutter:1rem] sm:[--wl-gutter:1.5rem]">
      <OrgBar orgName={props.orgName} brand={props.brand} />
      <TestRibbon mode={props.mode} what="pass" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-safe pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {props.backHref ? (
          <p className="mb-2 text-sm">
            <a
              href={props.backHref}
              className="text-fg-muted underline underline-offset-4 hover:text-fg-strong"
            >
              {HOLDER_COPY.allPassesLink}
            </a>
          </p>
        ) : null}
        <HolderHeading heading={headingOf(props)} bare />
        <HolderPassView
          pass={
            <PassCardStage
              view={view}
              enter
              tilt={active}
              glow={active}
              dim={!active}
              removed={state === 'removed'}
            />
          }
          passTitle={props.passTitle}
          orgName={props.orgName}
          state={state}
          removalMessage={props.removal?.message ?? null}
          device={props.device}
          downloadHref={props.downloadHref}
          walletOffers={props.walletOffers}
          {...(props.issuance ? { issuance: props.issuance } : {})}
          barcodeHref={props.barcodeHref}
          channels={props.channels}
          printHref={props.printHref}
          publicUrl={props.publicUrl}
          support={props.support}
          endedOn={props.endedOn ?? null}
          {...(props.resend && props.portalHref
            ? { resend: props.resend, portalHref: props.portalHref }
            : {})}
          {...(props.signin ? { signin: props.signin } : {})}
          {...(props.notice ? { notice: props.notice } : {})}
          details={
            <PassDetails
              passJson={props.passJson}
              view={view}
              locale={view.locale}
              now={props.now}
              {...(props.timeZone ? { timeZone: props.timeZone } : {})}
            />
          }
          rise
          macUnsure
        />
      </main>
      <OrgMark brand={props.brand} />
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
  const active = !props.removal && !voided && !props.view.expired;
  // The tab says what the pass is, as the portal's does; never the holder.
  const title = headingOf(props).title;
  const tilt = active ? '<script src="/pass-tilt.js" defer></script>' : '';
  // Save to this phone and dropping a copy once the pass ended; both are no-ops without a host.
  const door = doorPathOf(props.publicUrl);
  const save = door
    ? `<script src="${door.startsWith('/b/') ? BUNDLE_SAVE_PATH : PASS_SAVE_PATH}" defer></script>`
    : '';
  // A Mac agent may be an iPad: the Mac's badge shows only once the browser says it is a Mac.
  const mac =
    props.device.device === 'mac'
      ? `<script nonce="${props.nonce}">${MAC_REVEAL_SCRIPT}</script>`
      : '';
  const line = props.removal
    ? HOLDER_COPY.previewRemoved
    : voided
      ? HOLDER_COPY.previewVoided
      : active
        ? props.walletOffers.length > 0
          ? HOLDER_COPY.previewWallets
          : HOLDER_COPY.previewActive
        : HOLDER_COPY.expired;
  return `${documentStart(props.theme)}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">${previewHead(props.orgLabel, line)}<title>${escapeHtml(title)}</title>${tilt}${save}${REPLAY_SCRIPT}<style nonce="${props.nonce}">${PAGE_CSS}${brandCss(props.brand)}</style></head><body>${renderToStaticMarkup(<PassBody {...props} />)}${mac}</body></html>`;
}

/** The dead link's one way on: the login, which says the link did not work. Sends no mail. */
const DEAD_LINK_ACTION: PageAction = {
  label: HOLDER_COPY.emailMyPasses,
  href: '/login?next=/&reason=link',
  icon: WalletCards,
};

/**
 * An unknown, rotated or expired link: the hosted card with one way on, to sign-in. It names the
 * thing (pass or bundle) but never says which of the three it was, so it tells a guesser nothing.
 */
export function renderNotFoundPage(
  nonce: string,
  theme?: PageTheme,
  {
    what = 'pass',
    replay = true,
    drop = false,
  }: { what?: 'pass' | 'bundle'; replay?: boolean; drop?: boolean } = {},
): string {
  return hostedPage({
    nonce,
    theme,
    title: HOLDER_COPY.deadLinkTitle(what),
    art: 'expired',
    lede: escapeHtml(HOLDER_COPY.deadLinkLine),
    body: actionHtml(DEAD_LINK_ACTION),
    replay,
    // A retired /p link also retires this phone's saved copy of it (DROP_SCRIPT).
    ...(drop ? { after: `<script nonce="${nonce}">${DROP_SCRIPT}</script>` } : {}),
  });
}
