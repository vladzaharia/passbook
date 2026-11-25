import { renderToStaticMarkup } from 'react-dom/server';
import type { BrandMark } from '../../shared/contracts/orgs.ts';
import '../../web/pass-card/sync-barcode.ts';
import holderCss from '../../generated/ssr-holder.css?raw';
import { type PaperDesign, pageSizeOf } from '../../passkit/template/paper.ts';
import type { PaperContent } from '../../passkit/template/paper-content.ts';
import { PREVIEW_PAGE_COPY } from '../../shared/copy/developer.ts';
import { PREVIEW_COPY, walletName } from '../../shared/copy/previews.ts';
import { escapeHtml } from '../../shared/html.ts';
import type { PassView } from '../../shared/pass-view/index.ts';
import { FidelityNotes } from '../../web/channel-previews/fidelity-notes.tsx';
import type { WalletTargetOut } from '../../web/channel-previews/wallet-kit.ts';
import { PAPER_CSS } from '../../web/paper/css.ts';
import type { PaperDrawing } from '../../web/paper/drawing.ts';
import { PaperTicket } from '../../web/paper/ticket.tsx';
import { PassCardStage } from '../../web/pass-card/index.tsx';
import cardBase from '../../web/pass-card/pass-card-base.css?raw';
import cardPoster from '../../web/pass-card/pass-card-poster.css?raw';
import cardText from '../../web/pass-card/pass-card-text.css?raw';
import stageCss from '../../web/pass-card/stage.css?raw';
import stageMotion from '../../web/pass-card/stage-motion.css?raw';
import stageSeg from '../../web/pass-card/stage-seg.css?raw';
import { Badge } from '../../web/ui/badge.tsx';
import { Callout } from '../../web/ui/callout.tsx';
import googleCss from '../../web/wallet-previews/google/google.css?raw';
import { GoogleCard } from '../../web/wallet-previews/google/google-card.tsx';
import samsungCss from '../../web/wallet-previews/samsung/samsung.css?raw';
import { SamsungCard } from '../../web/wallet-previews/samsung/samsung-card.tsx';
import walletsCss from '../../web/wallet-previews/wallet-previews.css?raw';
import { documentStart, type PageTheme } from './head.ts';
import { actionHtml, hostedPage } from './hosted.ts';
import pageCss from './preview-page.css?raw';
import { THEME_CSS, WORDMARK_CSS, wordmarkHtml } from './theme.ts';

/** The page holds the pass's content: private, never cached or sent on in a referrer, never indexed. */
export const PREVIEW_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
};

const PAGE_CSS = [
  THEME_CSS,
  WORDMARK_CSS,
  holderCss,
  cardBase,
  cardPoster,
  cardText,
  stageCss,
  stageMotion,
  stageSeg,
  walletsCss,
  googleCss,
  samsungCss,
  PAPER_CSS,
  pageCss,
].join('\n');

/** The ticket as it prints, drawn from the pass's own content with a sample code. */
export interface PreviewPaper {
  content: PaperContent;
  design: PaperDesign;
  drawing: PaperDrawing | undefined;
  /** The org's footer choice. */
  mark: BrandMark;
  assets: { logo?: string | undefined; art?: string | undefined };
}

export interface PreviewPageProps {
  view: PassView;
  /** Null when a compiler could not read the pass. */
  wallets: WalletTargetOut | null;
  /** Null when the template has no printable ticket. */
  paper: PreviewPaper | null;
  /** What the pass is, for the line under the title. */
  passTitle: string;
  nonce: string;
  theme?: PageTheme | undefined;
}

const TABS = [
  ['apple', 'Apple'],
  ['google', 'Google'],
  ['samsung', 'Samsung'],
  ['paper', 'Paper'],
] as const;

/** One wallet's card beside its fidelity report, as the console's Google and Samsung panes show them. */
function WalletPane({
  target,
  out,
}: {
  target: 'google' | 'samsung';
  out: WalletTargetOut | null;
}) {
  const wallet = walletName(target);
  if (!out)
    return (
      <p className="pv-note" role="alert">
        {PREVIEW_COPY.failed}
      </p>
    );
  const { compiled, report } = out[target];
  if (compiled.type === 'off')
    return <p className="pv-note">{PREVIEW_COPY.walletOff.replace('{wallet}', wallet)}</p>;
  const card =
    target === 'samsung' ? (
      compiled.cardData ? (
        <SamsungCard
          data={compiled.cardData as Parameters<typeof SamsungCard>[0]['data']}
          testBand
        />
      ) : null
    ) : compiled.objectBody ? (
      <GoogleCard
        type={compiled.type}
        classBody={compiled.classBody}
        objectBody={compiled.objectBody}
        testBand
      />
    ) : null;
  return (
    <div className="wp-wrap w-full" data-testid={`${target}-channel`}>
      <div className="wp-split">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{PREVIEW_COPY.badge}</Badge>
            <span className="text-xs text-fg-muted">
              {PREVIEW_COPY.approximate.replace('{wallet}', wallet)}
            </span>
          </div>
          {compiled.blocked ? (
            <Callout tone="warning" title={PREVIEW_COPY.blocked.replace('{wallet}', wallet)}>
              {compiled.blocked.message}
            </Callout>
          ) : (
            card
          )}
        </div>
        <FidelityNotes report={report} />
      </div>
    </div>
  );
}

function PreviewBody({ view, wallets, paper, passTitle }: PreviewPageProps) {
  return (
    <main className="pv-main [--wl-gutter:1rem] sm:[--wl-gutter:1.5rem]">
      <div className="pv-head">
        <h1>{PREVIEW_PAGE_COPY.title}</h1>
        <p>
          <span className="pv-name">{passTitle}</span>
        </p>
        <p>{PREVIEW_PAGE_COPY.lede}</p>
      </div>
      <div className="pv-tabs">
        {TABS.map(([id], i) => (
          <input key={id} id={`pv-${id}`} type="radio" name="pv-channel" defaultChecked={i === 0} />
        ))}
        <fieldset className="pv-seg">
          <legend>{PREVIEW_PAGE_COPY.tabs}</legend>
          {TABS.map(([id, label]) => (
            <label key={id} htmlFor={`pv-${id}`}>
              {label}
            </label>
          ))}
        </fieldset>
        <div className="pv-stage">
          <section className="pv-panel" data-p="apple" aria-label="Apple Wallet">
            <PassCardStage view={view} enter toggleId="pv-flip" testBand />
          </section>
          <section className="pv-panel" data-p="google" aria-label="Google Wallet">
            <WalletPane target="google" out={wallets} />
          </section>
          <section className="pv-panel" data-p="samsung" aria-label="Samsung Wallet">
            <WalletPane target="samsung" out={wallets} />
          </section>
          <section
            className="pv-panel"
            data-p="paper"
            data-size={paper ? pageSizeOf(paper.design) : undefined}
            aria-label="Paper"
          >
            {paper ? (
              <PaperTicket
                content={paper.content}
                design={paper.design}
                code="PSAMPLEABCDEFGHIJKLMNOPQRST"
                mark={paper.mark}
                drawing={paper.drawing}
                assets={paper.assets}
                testBand
              />
            ) : (
              <p className="pv-note">{PREVIEW_PAGE_COPY.noPaper}</p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

const HEAD =
  '<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">';

export function renderPreviewPage(props: PreviewPageProps): string {
  const bar = `<header class="pv-bar"><div>${wordmarkHtml()}<span class="pv-tag">${escapeHtml(PREVIEW_PAGE_COPY.tag)}</span></div></header>`;
  const tilt = '<script src="/pass-tilt.js" defer></script>';
  return `${documentStart(props.theme)}${HEAD}<title>${escapeHtml(PREVIEW_PAGE_COPY.title)}</title>${tilt}<style nonce="${props.nonce}">${PAGE_CSS}</style></head><body>${bar}${renderToStaticMarkup(<PreviewBody {...props} />)}</body></html>`;
}

/** An expired or unknown link: the hosted card, with one way on. It never says which it was beyond the date rule. */
export function renderPreviewGone(
  nonce: string,
  kind: 'expired' | 'missing',
  theme?: PageTheme,
): string {
  const expired = kind === 'expired';
  return hostedPage({
    nonce,
    theme,
    title: expired ? PREVIEW_PAGE_COPY.expiredTitle : PREVIEW_PAGE_COPY.missingTitle,
    art: 'expired',
    lede: escapeHtml(expired ? PREVIEW_PAGE_COPY.expired : PREVIEW_PAGE_COPY.missing),
    body: actionHtml({ label: PREVIEW_PAGE_COPY.open, href: '/' }),
    head: '<meta name="referrer" content="no-referrer">',
  });
}
