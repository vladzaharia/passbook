import { ArrowLeft } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import type { Mode } from '../../shared/contracts/common.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { escapeHtml } from '../../shared/html.ts';
import { DOOR_SCRIPT, EXPIRES_HEADER } from '../../shared/pass-offline.ts';
import type { PresentationBarcode } from '../modules/public/presentation.ts';
import { documentStart, type PageTheme } from './head.ts';
import { actionHtml } from './hosted.ts';
import { orgLogoHtml, orgMarkHtml } from './org-bar.tsx';
import { brandCss, ORG_SHELL_CSS } from './org-brand-css.ts';
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

/**
 * The door view: a white field the scanner reads against, in every theme. The kit supplies the
 * button; everything else is this page's. Nothing but the code, the pass's name and the way
 * back. The code takes the page's width less the body's 1rem gutters and .5rem more, which is its
 * quiet zone against the white. No text of the credential or its altText: they never reach page text (presentation.test.ts).
 */
const CSS = `${RIBBON_CSS}
html,body{background:#fff;color:#0b1220}
body{margin:0;min-height:100dvh}
.door{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.5rem;min-height:100dvh;box-sizing:border-box;width:100%;max-width:30rem;margin:0 auto;padding:max(1.5rem,env(safe-area-inset-top)) .5rem max(1.5rem,env(safe-area-inset-bottom))}
.door-head{display:flex;flex-direction:column;align-items:center;gap:.25rem;text-align:center}
.door-head h1{margin:0;font-size:1.25rem;line-height:1.75rem;font-weight:600;overflow-wrap:anywhere;color:#0b1220}
.door-head p{margin:0;font-size:.875rem;line-height:1.25rem;color:#4b5563}
.brand{display:flex;justify-content:center;margin-bottom:.5rem}
.org-logo{display:block;max-width:100%;height:auto}
.org-name{display:none}
.presentation-figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:.75rem;width:100%}
.presentation-code{display:flex;justify-content:center;align-items:center;width:100%;padding:0;box-sizing:border-box;background:#fff;color:#000}
.presentation-code[data-square=true]{width:min(100%,24rem)}
.presentation-code svg{display:block;width:100%;height:auto}
.presentation-unavailable p{margin:0}
.door-foot{display:flex;flex-direction:column;align-items:center;gap:.75rem}
.door-foot p{margin:0;font-size:.875rem;line-height:1.25rem;color:#4b5563}
.door-foot [hidden]{display:none}
`;

/** The door view's headers; the pass's own expiry rides in one so a saved copy can honour it. */
export const presentationHeaders = (expiresAt: number | null | undefined) => ({
  ...PRESENTATION_HEADERS,
  ...(expiresAt ? { [EXPIRES_HEADER]: String(expiresAt) } : {}),
});

export interface PresentationPageProps {
  barcode: PresentationBarcode | null;
  orgName: string;
  /** The org's brand kit (`orgBrandOf`). */
  brand?: OrgBrand;
  passTitle: string;
  mode: Mode;
  backHref: string;
  /** The door view may be saved on this device: a pass's own, and a bundle member's under the bundle's worker. */
  offline?: boolean;
  /** The door script for this family (a bundle member's, else the pass's). */
  doorScript?: string;
  /** The pass's expiry (ms); the saved copy keeps it. */
  expiresAt?: number | null;
  nonce: string;
  /** Ignored: the door is white in every theme. */
  theme?: PageTheme;
}

/** The credential is encoded only in SVG geometry, never echoed in page text or attributes. */
export function renderPresentationPage(props: PresentationPageProps): string {
  const ribbon = renderToStaticMarkup(<TestRibbon mode={props.mode} what="pass" />);
  const code = renderToStaticMarkup(
    <PresentationCode barcode={props.barcode} orgName={props.orgName} />,
  );
  const saveable = Boolean(props.offline && props.barcode);
  // A saved page keeps no token in its HTML: the way back is relative (/p/<token>/barcode -> /p/<token>/).
  const back = actionHtml({
    label: HOLDER_COPY.backToPass,
    href: saveable ? './' : props.backHref,
    icon: ArrowLeft,
  });
  const foot = `<div class="door-foot">${
    saveable ? `<p data-door-saved hidden>${escapeHtml(HOLDER_COPY.worksOffline)}</p>` : ''
  }${back}</div>`;
  const logo = props.brand?.logo ? `<div class="brand">${orgLogoHtml(props.brand)}</div>` : '';
  const head = `<div class="door-head">${logo}<h1>${escapeHtml(props.passTitle)}</h1><p>${escapeHtml(props.orgName)}</p></div>`;
  return `${documentStart('light')}<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><meta property="og:title" content="${escapeHtml(HOLDER_COPY.barcodeTitle)}"><meta name="apple-mobile-web-app-title" content="${escapeHtml(props.orgName || 'Pass')}"><title>${escapeHtml(HOLDER_COPY.barcodeTitle)} · ${escapeHtml(props.brand?.name || props.orgName || 'PassBook')}</title><style nonce="${props.nonce}">${THEME_CSS}${props.brand ? `${ORG_SHELL_CSS}\n${brandCss(props.brand)}` : ''}${CSS}</style></head><body><main class="door">${ribbon}${head}${code}${foot}${orgMarkHtml(props.brand)}</main>${saveable ? `<script nonce="${props.nonce}">${props.doorScript ?? DOOR_SCRIPT}</script>` : ''}</body></html>`;
}
