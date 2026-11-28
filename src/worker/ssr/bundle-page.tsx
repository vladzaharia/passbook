import { renderToStaticMarkup } from 'react-dom/server';
import '../../web/pass-card/sync-barcode.ts';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import type { Mode } from '../../shared/contracts/common.ts';
import type { WalletProvider } from '../../shared/contracts/wallet-providers.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { addLine, type DeviceInfo, isAndroid, MAC_REVEAL_SCRIPT } from '../../shared/device.ts';
import { escapeHtml } from '../../shared/html.ts';
import type { PassView } from '../../shared/pass-view/index.ts';
import { NATIVE_WALLET_BADGES } from '../../shared/wallet-choice.ts';
import { statusOf } from '../../web/lib/status.ts';
import { hasBack } from '../../web/pass-card/back.tsx';
import { PassCardStage } from '../../web/pass-card/index.tsx';
import { AddBlock } from '../../web/portal/add/add-block.tsx';
import { OUTLINE_ACTION_CLASS } from '../../web/portal/add/added.tsx';
import { type AddAreaProps, addMode } from '../../web/portal/add/area.ts';
import { HolderHeading } from '../../web/portal/holder-heading.tsx';
import { Help, type HolderSupport, Notice } from '../../web/portal/holder-parts.tsx';
import { PassDetails } from '../../web/portal/pass-details.tsx';
import stackCss from '../../web/portal/pass-stack.css?raw';
import { PassStack } from '../../web/portal/pass-stack.tsx';
import { AppleWalletBadge } from '../../web/ui/apple-wallet-badge.tsx';
import { BuddyArt } from '../../web/ui/art/buddy-art.tsx';
import { Badge } from '../../web/ui/badge.tsx';
import { GoogleAllLinks } from './bundle-google-all.tsx';
import bundleCss from './bundle-page.css?raw';
import { documentStart, type PageTheme } from './head.ts';
import { REPLAY_SCRIPT } from './hosted.ts';
import { OrgBar, OrgMark } from './org-bar.tsx';
import { brandCss } from './org-brand-css.ts';
import { PAGE_CSS } from './pass-page.tsx';
import { TestRibbon } from './test-ribbon.tsx';

export const BUNDLE_COPY = {
  addAll: 'Add all to Apple Wallet',
  count: HOLDER_COPY.count,
  /** The line under the title: only what is not live. The stack shows the count. */
  extras: (voided: number, removed = 0) =>
    [voided ? `${voided} voided` : '', removed ? `${removed} removed` : '']
      .filter(Boolean)
      .join(' · '),
  allPasses: HOLDER_COPY.allPasses,
  qrAlt: (name: string) => `QR code for ${name}`,
  preview: 'Open these passes.',
  details: 'Details',
} as const;

export interface BundlePageItem {
  id: string;
  view: PassView;
  title: string;
  /** "Tier: Plus": tells same-titled passes apart. */
  detail?: string | null;
  /** Voided passes and removed ones cannot be added. */
  state: 'active' | 'voided' | 'removed';
  /** `/b/:token/:passId/open`: the member's own page, a plain link from its peek. */
  href: string;
  /** `/b/:token/:passId/pass.pkpass`; null while Apple is off for the pass. */
  downloadHref: string | null;
  /** `/b/:token/:passId/barcode`: the browser barcode, shown on Android; absent while mobile is off. */
  barcodeHref?: string | undefined;
  /** `/b/:token/:passId/wallet/:provider` for each native wallet the pass may be saved to. */
  walletOffers?: readonly { provider: WalletProvider; href: string }[];
}

export interface BundlePageProps {
  nonce: string;
  theme?: PageTheme;
  /** The org's name for the header (never the platform's). */
  orgName: string;
  /** The org's brand kit (`orgBrandOf`). */
  brand?: OrgBrand;
  /** The org record's name, for link previews. */
  orgLabel: string;
  name: string;
  items: BundlePageItem[];
  /** A test bundle carries a ribbon. */
  mode?: Mode;
  addAllHref: string;
  /** One Google save link per part when two or more members offer Google Wallet. */
  googleAllHrefs?: readonly string[];
  /** The absolute URL of this page: the add QR encodes it. */
  publicUrl: string;
  device: DeviceInfo;
  support?: HolderSupport;
  /** The request clock, for the details' dates. */
  now?: Date;
}

/** The kit's status words for a pass that cannot be added (the SPA's StatusPill needs the DOM). */
function OffBadge({ state }: { state: 'voided' | 'removed' }) {
  const status = statusOf(state);
  const Icon = status?.icon;
  return (
    <Badge tone="warning">
      {Icon ? <Icon aria-hidden /> : null}
      {status?.label}
    </Badge>
  );
}

/** Under a voided pass: what it means and who to ask; a removed one needs no next step. */
function OffNote({
  state,
  orgName,
  support,
}: {
  state: 'voided' | 'removed';
  orgName: string;
  support?: HolderSupport | undefined;
}) {
  if (state === 'removed') return null;
  const own = support && !support.platform ? support : null;
  const href = own?.email ? `mailto:${own.email}` : own?.url;
  return (
    <p className="bd-note">
      {HOLDER_COPY.voidedShort}{' '}
      {href ? <a href={href}>{HOLDER_COPY.contact(orgName)}</a> : HOLDER_COPY.askForNew(orgName)}
    </p>
  );
}

/** The front pass's way in: its door view, or the reason it has none. The others are one tap away. */
function FrontWay({
  item,
  android,
  orgName,
  support,
}: {
  item: BundlePageItem;
  android: boolean;
  orgName: string;
  support?: HolderSupport | undefined;
}) {
  const wallets = item.state === 'active' ? (item.walletOffers ?? []) : [];
  const door = item.state === 'active' && (android || !item.downloadHref) && item.barcodeHref;
  if (item.state !== 'active') {
    return (
      <div className="bd-way">
        <OffBadge state={item.state} />
        <OffNote state={item.state} orgName={orgName} support={support} />
      </div>
    );
  }
  if (!door && wallets.length === 0) return null;
  return (
    <div className="bd-way">
      {door ? (
        <a className={OUTLINE_ACTION_CLASS} href={door} aria-describedby={`bd-n-${item.id}`}>
          {android ? HOLDER_COPY.showAtDoor : HOLDER_COPY.showBarcode}
        </a>
      ) : null}
      {wallets.map(({ provider, href }) => (
        <div key={provider} className="wl-native-wallets">
          <a href={href} aria-describedby={`bd-n-${item.id}`}>
            <img
              src={NATIVE_WALLET_BADGES[provider].path}
              alt={NATIVE_WALLET_BADGES[provider].label}
            />
          </a>
        </div>
      ))}
    </div>
  );
}

/** A peek is read by what it is, and by why it is dim. */
function peekName(item: BundlePageItem): string {
  const off = item.state === 'active' ? null : statusOf(item.state)?.label;
  return [item.title, item.detail, off].filter(Boolean).join(', ');
}

function BundleBody(props: BundlePageProps) {
  const { items, device, support } = props;
  const addable = items.filter((i) => i.state === 'active');
  const voided = items.filter((i) => i.state === 'voided').length;
  const removed = items.filter((i) => i.state === 'removed').length;
  const android = isAndroid(device.device);
  const apple = addable.filter((i) => i.downloadHref);
  const front = addable[0] ?? items[0];
  // Live passes first; the ended ones sit at the bottom of the stack.
  const rest = items
    .filter((i) => i !== front)
    .sort((a, b) => Number(a.state !== 'active') - Number(b.state !== 'active'));
  const mode = apple.length > 0 ? addMode('active', device, false, props.publicUrl) : 'off';
  const labelled = apple.length > 1;
  const area: AddAreaProps | null =
    mode === 'off'
      ? null
      : {
          mode,
          device,
          publicUrl: props.publicUrl,
          qrLabel: BUNDLE_COPY.qrAlt(props.name),
          // As on the pass page: off the phone only a Mac adds beside the QR.
          badge:
            device.device === 'other' ? null : (
              <AppleWalletBadge
                href={props.addAllHref}
                {...(labelled ? { label: BUNDLE_COPY.allPasses(apple.length) } : {})}
                className="p-0"
              />
            ),
          line: device.device === 'other' ? null : addLine(device),
          macUnsure: true,
        };
  return (
    <div className="flex min-h-dvh flex-col [--wl-gutter:1rem] sm:[--wl-gutter:1.5rem]">
      <OrgBar orgName={props.orgName} brand={props.brand} />
      <TestRibbon mode={props.mode} what="bundle" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-safe pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <HolderHeading
          heading={{ title: props.name, org: '', kind: null }}
          {...(voided || removed
            ? { meta: <span>{BUNDLE_COPY.extras(voided, removed)}</span> }
            : {})}
        />
        <div className="bd-top">
          {area && android ? (
            <AddBlock {...area} buddy={(p) => <BuddyArt {...p} playOnLoad />} />
          ) : area ? (
            // The pass page's lead: the card says what it adds, no heading over it.
            <div className="bd-add">
              <AddBlock {...area} buddy={(p) => <BuddyArt {...p} playOnLoad />} />
            </div>
          ) : addable.length === 0 ? (
            <Notice
              state={voided === 0 ? 'removed' : 'voided'}
              orgName={props.orgName}
              support={support}
              many={voided === 0 || removed === 0}
              mixed={voided > 0 && removed > 0}
            />
          ) : null}
          <GoogleAllLinks hrefs={props.googleAllHrefs ?? []} />
        </div>
        {front ? (
          <div className="bd-stack">
            <PassStack
              label={BUNDLE_COPY.count(items.length)}
              className="wl-buddy-room"
              front={
                <>
                  <PassCardStage
                    view={front.view}
                    tilt={false}
                    glow={false}
                    enter
                    dim={front.state !== 'active'}
                    removed={front.state === 'removed'}
                  />
                  <p className="bd-name" id={`bd-n-${front.id}`}>
                    {front.title}
                    {front.detail ? <span className="bd-detail">{front.detail}</span> : null}
                  </p>
                  <FrontWay
                    item={front}
                    android={android}
                    orgName={props.orgName}
                    support={support}
                  />
                </>
              }
              peeks={rest.map((item) => ({
                id: item.id,
                view: item.view,
                name: peekName(item),
                href: item.href,
                dim: item.state !== 'active',
                removed: item.state === 'removed',
                // Android has no Apple add: each live member shows at the door from its own row.
                ...(android && item.state === 'active' && item.barcodeHref
                  ? {
                      way: (
                        <a
                          className={OUTLINE_ACTION_CLASS}
                          href={item.barcodeHref}
                          aria-label={`${HOLDER_COPY.showAtDoor}, ${item.title}`}
                        >
                          {HOLDER_COPY.showAtDoor}
                        </a>
                      ),
                    }
                  : {}),
              }))}
            />
            {hasBack(front.view, front.view.layouts[front.view.target]) ? (
              // The front pass's details, folded: a native disclosure, no script.
              <details className="bd-more">
                <summary>{BUNDLE_COPY.details}</summary>
                <PassDetails
                  view={front.view}
                  locale={front.view.locale}
                  now={props.now ?? new Date()}
                />
              </details>
            ) : null}
          </div>
        ) : null}
        {support && !support.platform && (support.email || support.url) ? (
          <div className="bd-help border-t border-border pt-4">
            <Help support={support} />
          </div>
        ) : null}
      </main>
      <OrgMark brand={props.brand} />
    </div>
  );
}

/** A link preview names the org, never the bundle or a holder. */
function previewHead(org: string): string {
  const title = org ? `${escapeHtml(org)} passes` : 'Passes';
  const line = escapeHtml(BUNDLE_COPY.preview);
  return `<meta name="description" content="${line}"><meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${line}"><meta name="apple-mobile-web-app-title" content="${escapeHtml(org || 'Passes')}">`;
}

export function renderBundlePage(props: BundlePageProps): string {
  return `${documentStart(props.theme)}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">${previewHead(props.orgLabel)}<title>${escapeHtml(props.orgLabel ? `${props.orgLabel} passes` : 'Passes')}</title>${REPLAY_SCRIPT}<style nonce="${props.nonce}">${PAGE_CSS}\n${stackCss}\n${bundleCss}${brandCss(props.brand)}</style></head><body>${renderToStaticMarkup(<BundleBody {...props} />)}${props.device.device === 'mac' ? `<script nonce="${props.nonce}">${MAC_REVEAL_SCRIPT}</script>` : ''}</body></html>`;
}
