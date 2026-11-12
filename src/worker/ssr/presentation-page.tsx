import { renderToStaticMarkup } from 'react-dom/server';
import type { Mode } from '../../shared/contracts/common.ts';
import type { PresentationBarcode } from '../modules/public/presentation.ts';
import { documentStart, type PageTheme } from './head.ts';
import { PresentationCode } from './presentation-code.tsx';
import { RIBBON_CSS, TestRibbon } from './test-ribbon.tsx';
import { THEME_CSS } from './theme.ts';

export const PRESENTATION_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

const CSS = `${THEME_CSS}${RIBBON_CSS}
.presentation{max-width:32rem;margin:0 auto;padding:2rem 0 3rem}
.presentation h1{color:var(--pk-text-strong);font-size:var(--pk-font-size-2xl);line-height:var(--pk-line-height-2xl);margin:.25rem 0}
.presentation p{margin:.5rem 0;color:var(--pk-text-muted)}
.presentation-org{font-weight:600;color:var(--pk-text-strong)!important}
.presentation-panel{margin-top:1.5rem;padding:1.5rem;border:1px solid var(--pk-border-subtle);border-radius:var(--pk-radius-xl);background:var(--pk-surface-raised);box-shadow:var(--pk-elevation-1)}
.presentation-panel h2{margin:0;color:var(--pk-text-strong);font-size:1.125rem}
.presentation-figure{margin:1.25rem 0;text-align:center}
.presentation-code{display:inline-flex;justify-content:center;align-items:center;width:min(100%,26rem);padding:1.25rem;background:#fff;color:#000}
.presentation-code[data-square=true]{width:min(100%,22rem)}
.presentation-code svg{display:block;width:100%;height:auto}
.presentation-figure figcaption{margin-top:.75rem;font-size:.875rem;color:var(--pk-text-muted)}
.presentation-unavailable{margin:1.25rem 0;padding:1rem;border:1px solid var(--pk-border-subtle);border-radius:var(--pk-radius-md)}
.presentation-back{margin-top:1.5rem}
@media(max-width:360px){.presentation-panel{padding:1rem}.presentation-code{padding:1rem}}
`;

export interface PresentationPageProps {
  barcode: PresentationBarcode | null;
  orgName: string;
  passTitle: string;
  mode: Mode;
  backHref: string;
  nonce: string;
  theme?: PageTheme;
}

/** The credential is encoded only in SVG geometry, never echoed in page text or attributes. */
export function renderPresentationPage(props: PresentationPageProps): string {
  const body = renderToStaticMarkup(
    <main className="presentation">
      <TestRibbon mode={props.mode} what="pass" />
      <p className="presentation-org">{props.orgName}</p>
      <h1>Presentation barcode</h1>
      <p>Use your pass in a browser.</p>
      <section className="presentation-panel" aria-label="Presentation barcode">
        <h2>{props.passTitle}</h2>
        <PresentationCode barcode={props.barcode} />
        <p>This barcode is separate from the QR code that opens your pass page.</p>
        <p>Browser pages do not provide NFC.</p>
      </section>
      <div className="presentation-back">
        <a className="btn outline" href={props.backHref}>
          Back to pass
        </a>
      </div>
    </main>,
  );
  return `${documentStart(props.theme)}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>Presentation barcode</title><style nonce="${props.nonce}">${CSS}</style></head><body>${body}</body></html>`;
}

/** Do not distinguish a rotated link from any other unavailable pass. */
export function renderPresentationNotFound(nonce: string, theme?: PageTheme): string {
  const body = renderToStaticMarkup(
    <main className="presentation">
      <h1>Pass unavailable</h1>
      <p>Sign in to see your passes, or contact the organization that issued this pass.</p>
      <div className="presentation-back">
        <a className="btn outline" href="/">
          My passes
        </a>
      </div>
    </main>,
  );
  return `${documentStart(theme)}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>Pass unavailable</title><style nonce="${nonce}">${CSS}</style></head><body>${body}</body></html>`;
}
