import { Ban } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../web/pass-card/sync-barcode.ts';
import { addLine, type DeviceInfo } from '../../shared/device.ts';
import { escapeHtml } from '../../shared/html.ts';
import type { PassView } from '../../shared/pass-view/index.ts';
import { PassCardStage } from '../../web/pass-card/index.tsx';
import { AddBlock } from '../../web/portal/add/add-block.tsx';
import { type AddAreaProps, addMode } from '../../web/portal/add/area.ts';
import { Help, type HolderSupport } from '../../web/portal/holder-parts.tsx';
import { AppleWalletBadge } from '../../web/ui/apple-wallet-badge.tsx';
import { BuddyArt } from '../../web/ui/art/buddy-art.tsx';
import bundleCss from './bundle-page.css?raw';
import { documentStart, type PageTheme } from './head.ts';
import { REPLAY_SCRIPT } from './hosted.ts';
import { PAGE_CSS } from './pass-page.tsx';

export const BUNDLE_COPY = {
  addAll: 'Add all to Apple Wallet',
  count: (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`,
  allVoided: 'None of these passes can be added.',
  voided: 'Voided',
  qrAlt: (name: string) => `QR code for ${name}`,
  preview: 'Add these passes to Apple Wallet.',
} as const;

export interface BundlePageItem {
  id: string;
  view: PassView;
  title: string;
  voided: boolean;
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
  addAllHref: string;
  /** The absolute URL of this page: the add QR encodes it. */
  publicUrl: string;
  device: DeviceInfo;
  support?: HolderSupport;
}

function BundleBody(props: BundlePageProps) {
  const { items, device, support } = props;
  const addable = items.filter((i) => !i.voided);
  const icon = items[0]?.view.images.icon;
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
        <header className="mb-6 min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong [overflow-wrap:anywhere]">
            {props.name}
          </h1>
          <p className="mt-1.5 text-sm text-fg-muted">{BUNDLE_COPY.count(items.length)}</p>
        </header>
        <div className="bd-top">
          {area ? (
            <section className="bd-add" aria-labelledby="bd-add">
              <h2 id="bd-add">{BUNDLE_COPY.addAll}</h2>
              <AddBlock {...area} buddy={(p) => <BuddyArt {...p} playOnLoad />} />
            </section>
          ) : (
            <p className="bd-empty" role="status">
              {BUNDLE_COPY.allVoided}
            </p>
          )}
        </div>
        <ul className="bd-list" aria-label={BUNDLE_COPY.count(items.length)}>
          {items.map((item, i) => (
            <li key={item.id} className="bd-item" style={{ '--bd-i': i } as React.CSSProperties}>
              <PassCardStage
                view={item.view}
                tilt={false}
                glow={false}
                dim={item.voided}
                toggleId={`pc-${item.id}`}
              />
              <p className="bd-name">{item.title}</p>
              {item.voided ? (
                <p className="bd-void">
                  <Ban aria-hidden />
                  {BUNDLE_COPY.voided}
                </p>
              ) : (
                <AppleWalletBadge href={item.downloadHref} className="p-0" />
              )}
            </li>
          ))}
        </ul>
        {support?.email || support?.url ? (
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
  return `${documentStart(props.theme)}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">${previewHead(props.orgLabel)}<title>${escapeHtml(props.name)}</title>${REPLAY_SCRIPT}<style nonce="${props.nonce}">${PAGE_CSS}\n${bundleCss}</style></head><body>${renderToStaticMarkup(<BundleBody {...props} />)}</body></html>`;
}
