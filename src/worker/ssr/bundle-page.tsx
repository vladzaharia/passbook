import { renderToStaticMarkup } from 'react-dom/server';
import '../../web/pass-card/sync-barcode.ts';
import type { Mode } from '../../shared/contracts/common.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { addLine, type DeviceInfo } from '../../shared/device.ts';
import { escapeHtml } from '../../shared/html.ts';
import type { PassView } from '../../shared/pass-view/index.ts';
import { statusOf } from '../../web/lib/status.ts';
import { PassCardStage } from '../../web/pass-card/index.tsx';
import { AddBlock } from '../../web/portal/add/add-block.tsx';
import { type AddAreaProps, addMode } from '../../web/portal/add/area.ts';
import { HolderHeading } from '../../web/portal/holder-heading.tsx';
import { Help, type HolderSupport, Notice, PortalLink } from '../../web/portal/holder-parts.tsx';
import { AppleWalletBadge } from '../../web/ui/apple-wallet-badge.tsx';
import { BuddyArt } from '../../web/ui/art/buddy-art.tsx';
import { Badge } from '../../web/ui/badge.tsx';
import bundleCss from './bundle-page.css?raw';
import { documentStart, type PageTheme } from './head.ts';
import { REPLAY_SCRIPT } from './hosted.ts';
import { OrgBar } from './org-bar.tsx';
import { PAGE_CSS } from './pass-page.tsx';
import { TestRibbon } from './test-ribbon.tsx';

export const BUNDLE_COPY = {
  addAll: 'Add all to Apple Wallet',
  count: HOLDER_COPY.count,
  /** "3 passes · 1 voided" under the title. */
  summary: (n: number, off: number) =>
    `${n} ${n === 1 ? 'pass' : 'passes'}${off ? ` · ${off} voided` : ''}`,
  qrAlt: (name: string) => `QR code for ${name}`,
  preview: 'Add these passes to Apple Wallet.',
} as const;

export interface BundlePageItem {
  id: string;
  view: PassView;
  title: string;
  /** Voided passes and removed ones cannot be added. */
  state: 'active' | 'voided' | 'removed';
  /** `/b/:token/:passId/pass.pkpass`. */
  downloadHref: string;
}

export interface BundlePageProps {
  nonce: string;
  theme?: PageTheme;
  /** The org's name for the header (never the platform's). */
  orgName: string;
  /** The org record's name, for link previews. */
  orgLabel: string;
  name: string;
  items: BundlePageItem[];
  /** A test bundle carries a ribbon. */
  mode?: Mode;
  addAllHref: string;
  /** The absolute URL of this page: the add QR encodes it. */
  publicUrl: string;
  device: DeviceInfo;
  support?: HolderSupport;
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

function BundleBody(props: BundlePageProps) {
  const { items, device, support } = props;
  const addable = items.filter((i) => i.state === 'active');
  const off = items.length - addable.length;
  const mode = addable.length > 0 ? addMode('active', device, false, props.publicUrl) : 'off';
  const area: AddAreaProps | null =
    mode === 'off'
      ? null
      : {
          mode,
          device,
          publicUrl: props.publicUrl,
          qrLabel: BUNDLE_COPY.qrAlt(props.name),
          badge: (
            <AppleWalletBadge
              href={props.addAllHref}
              label={BUNDLE_COPY.count(addable.length)}
              className="p-0"
            />
          ),
          line: device.device === 'other' ? null : addLine(device),
        };
  return (
    <div className="flex min-h-dvh flex-col [--wl-gutter:1rem] sm:[--wl-gutter:1.5rem]">
      <OrgBar orgName={props.orgName} />
      <TestRibbon mode={props.mode} what="bundle" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-safe pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <HolderHeading
          heading={{ title: props.name, org: '', kind: null }}
          meta={<span>{BUNDLE_COPY.summary(items.length, off)}</span>}
          actions={<PortalLink href="/" />}
        />
        <div className="bd-top">
          {area ? (
            <section className="bd-add" aria-labelledby="bd-add">
              <h2 id="bd-add">{BUNDLE_COPY.addAll}</h2>
              <AddBlock {...area} buddy={(p) => <BuddyArt {...p} playOnLoad />} />
            </section>
          ) : (
            <Notice state="voided" orgName={props.orgName} support={support} many />
          )}
        </div>
        <ul className="bd-list" aria-label={BUNDLE_COPY.count(items.length)}>
          {items.map((item, i) => (
            <li key={item.id} className="bd-item" style={{ '--i': i } as React.CSSProperties}>
              <PassCardStage
                view={item.view}
                tilt={false}
                glow={false}
                enter
                dim={item.state !== 'active'}
                removed={item.state === 'removed'}
                toggleId={`pc-${item.id}`}
              />
              <p className="bd-name" id={`bd-n-${item.id}`}>
                {item.title}
              </p>
              <div className="bd-way">
                {item.state !== 'active' ? (
                  <OffBadge state={item.state} />
                ) : (
                  <AppleWalletBadge
                    href={item.downloadHref}
                    describedBy={`bd-n-${item.id}`}
                    className="p-0"
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
        {support && !support.platform && (support.email || support.url) ? (
          <div className="bd-help border-t border-border pt-4">
            <Help support={support} />
          </div>
        ) : null}
      </main>
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
  return `${documentStart(props.theme)}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">${previewHead(props.orgLabel)}<title>${escapeHtml(props.orgLabel ? `${props.orgLabel} passes` : 'Passes')}</title>${REPLAY_SCRIPT}<style nonce="${props.nonce}">${PAGE_CSS}\n${bundleCss}</style></head><body>${renderToStaticMarkup(<BundleBody {...props} />)}</body></html>`;
}
