import { ArrowLeft } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import type { Mode } from '../../shared/contracts/common.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { OFFLINE_SCRIPT } from '../../shared/pass-offline.ts';
import type { PresentationBarcode } from '../modules/public/presentation.ts';
import type { PageTheme } from './head.ts';
import { actionHtml, hostedPage } from './hosted.ts';
import { PresentationCode } from './presentation-code.tsx';
import { RIBBON_CSS, TestRibbon } from './test-ribbon.tsx';
import { escapeHtml } from './theme.ts';

export const PRESENTATION_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

/** The code's tile and the offline row, on the hosted card (hosted.ts). */
const CSS = `${RIBBON_CSS}
.presentation-figure{margin:0;display:flex;justify-content:center}
.presentation-code{display:flex;justify-content:center;align-items:center;width:min(100%,26rem);padding:1.25rem;border:1px solid var(--pk-border-subtle);border-radius:var(--pk-radius-lg);background:#fff;color:#000;box-shadow:var(--pk-elevation-1)}
.presentation-code[data-square=true]{width:min(100%,20rem)}
.presentation-code svg{display:block;width:100%;height:auto}
.presentation-unavailable p{margin:0}
.presentation-offline{display:flex;flex-direction:column;gap:.75rem}
.presentation-offline[hidden],.presentation-offline [hidden]{display:none}
.presentation-offline p{margin:0;font-size:.875rem;line-height:1.25rem;color:var(--pk-text-muted)}
@media(max-width:360px){.presentation-code{padding:1rem}}
`;

export interface PresentationPageProps {
  barcode: PresentationBarcode | null;
  orgName: string;
  /** The org's brand kit (`orgBrandOf`). */
  brand?: OrgBrand;
  passTitle: string;
  mode: Mode;
  backHref: string;
  /** A pass page's own barcode may be saved on this device; a bundle's member's may not. */
  offline?: boolean;
  /** The pass's expiry (ms); the saved copy keeps it. */
  expiresAt?: number | null;
  nonce: string;
  theme?: PageTheme;
}

/** The credential is encoded only in SVG geometry, never echoed in page text or attributes. */
export function renderPresentationPage(props: PresentationPageProps): string {
  const ribbon = renderToStaticMarkup(<TestRibbon mode={props.mode} what="pass" />);
  const code = renderToStaticMarkup(
    <PresentationCode barcode={props.barcode} orgName={props.orgName} />,
  );
  const saved =
    props.offline && props.barcode
      ? renderToStaticMarkup(
          <div
            className="presentation-offline"
            data-offline
            {...(props.expiresAt ? { 'data-expires': props.expiresAt } : {})}
            hidden
          >
            <button type="button" className="btn outline" data-save>
              {HOLDER_COPY.saveOffline}
            </button>
            <p data-state hidden>
              {HOLDER_COPY.savedOffline}
            </p>
            <button type="button" className="btn outline" data-drop hidden>
              {HOLDER_COPY.removeSaved}
            </button>
            <p data-fail role="alert" hidden>
              {HOLDER_COPY.saveOfflineFailed}
            </p>
            <p>{HOLDER_COPY.saveOfflineLine}</p>
          </div>,
        )
      : '';
  const back = actionHtml({ label: HOLDER_COPY.backToPass, href: props.backHref, icon: ArrowLeft });
  return hostedPage({
    nonce: props.nonce,
    theme: props.theme,
    ...(props.brand ? { brand: props.brand } : {}),
    title: props.passTitle,
    art: 'login',
    lede: escapeHtml(HOLDER_COPY.presentLine),
    wide: true,
    replay: false,
    css: CSS,
    head: '<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">',
    body: `${ribbon}${code}${saved}${back}`,
    after:
      props.offline && props.barcode
        ? `<script nonce="${props.nonce}">${OFFLINE_SCRIPT}</script>`
        : '',
  });
}
