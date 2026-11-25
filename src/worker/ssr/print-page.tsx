import { Ban, Download, Printer, RotateCcw, TriangleAlert } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import holderCss from '../../generated/ssr-holder.css?raw';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import { PRINT_COPY } from '../../shared/copy/print.ts';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { PAPER_CSS, pageRule } from '../../web/paper/css.ts';
import { drawPaperCode } from '../../web/paper/drawing.ts';
import { PaperTicket } from '../../web/paper/ticket.tsx';
import { BuddyArt } from '../../web/ui/art/buddy-art.tsx';
import { ART_CSS } from '../../web/ui/art/css.ts';
import inspectCss from '../../web/ui/art/scenes/inspect.css?raw';
import type { PrintAudience, PrintPageModel } from '../modules/prints/page.ts';
import { hasUndrawable } from '../modules/prints/pdf-coverage.ts';
import { documentStart, type PageTheme } from './head.ts';
import { actionHtml, hostedPage } from './hosted.ts';
import { HOSTED_ART_CSS, stateArtHtml } from './hosted-art.tsx';
import { iconHtml } from './icon.ts';
import { OrgBar, OrgMark } from './org-bar.tsx';
import { brandCss, ORG_SHELL_CSS } from './org-brand-css.ts';
import { RIBBON_CSS, TestRibbon } from './test-ribbon.tsx';
import { escapeHtml, THEME_CSS } from './theme.ts';

/** The code is in the page, so it is private and never cached or sent on in a referrer. */
export const PRINT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

/** Screen: the sheet under its actions. Print: the sheet alone, at its true size. */
const PAGE_CSS = `${RIBBON_CSS}
.hosted.wide{max-width:40rem}
.pp-stage{display:flex;flex-direction:column;gap:1rem}
.pp-actions{display:flex;flex-wrap:wrap;gap:.5rem}
.pp-actions .btn{width:auto;flex:1 1 7.5rem}
.pp-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:0;padding:.75rem 1rem;border:1px solid var(--pk-border-strong);border-radius:var(--pk-radius-md);background:var(--pk-surface-sunken)}
.pp-confirm p{flex:1 1 12rem;margin:0}
.pp-confirm .btn{width:auto}
.pp-confirm[hidden],.pp-error[hidden]{display:none}
.pp-error{margin:0;color:var(--pk-danger-fg,var(--pk-text-strong))}
.callout.pp-lossy{margin:0;border-color:var(--pk-warning-border);background:var(--pk-warning-subtle)}
.callout.pp-lossy>svg{color:var(--pk-warning)}
.pp-empty p,.pp-unavailable p{margin:0}
${PAPER_CSS}`;

/** The org's page: its bar, then the ticket. No PassBook band; the footer line on the sheet is the only mention. */
const HOLDER_CSS = `${THEME_CSS}${holderCss}
${ART_CSS}
${HOSTED_ART_CSS}
${inspectCss}
${PAGE_CSS}
body{padding:0}
.pp-main{width:100%;max-width:64rem;margin:0 auto;padding:1.5rem max(var(--wl-gutter,1rem),env(safe-area-inset-left)) max(2rem,env(safe-area-inset-bottom))}
.pp-head h1{margin:0;font-size:var(--pk-font-size-2xl);line-height:var(--pk-line-height-2xl);font-weight:var(--pk-font-weight-semibold);letter-spacing:var(--pk-tracking-tight);color:var(--pk-text-strong)}
.pp-main .pp-stage{margin-top:1rem}
.pp-main .pp-stage,.pp-main .pp-head,.pp-main .pp-unavailable,.pp-main .pp-back{max-width:40rem}
.pp-lede{margin:.25rem 0 0;font-size:.875rem;line-height:1.25rem;color:var(--pk-text-muted)}
.pp-scene{position:relative;width:128px;height:96px;margin:0 0 1rem;pointer-events:none}
.pp-scene .wl-art{width:128px;height:96px}
.pp-scene>[data-replay]{display:block}
.pp-scene-pair{width:214px}
.pp-back{display:flex;margin-top:.5rem}`;

const PRINT_ONLY_CSS = `@media print{
html,body{background:#fff}
body{min-height:0;padding:0}
.band,.body>div:first-child,.body>a.btn,.pp-noprint,.pp-head,.pp-actions,.pp-confirm,.pp-error,.pp-empty,.pp-ribbon,.pp-scene,.pp-back,.card::before{display:none!important}
.hosted,.hosted.wide{display:block;max-width:none;min-height:0;padding:0}
.card{display:block;overflow:visible;border:0;border-radius:0;background:#fff;box-shadow:none}
.body{display:block;padding:0}
.pp-main{display:block;max-width:none;margin:0;padding:0}
}`;

const SCRIPT = (nonce: string) => `<script nonce="${nonce}">(()=>{
const err=document.querySelector('[data-error]');
const say=(m)=>{if(err){err.textContent=m;err.hidden=false}};
const post=async(path)=>{if(err)err.hidden=true;try{const r=await fetch(location.pathname+path,{method:'POST',credentials:'same-origin',headers:{accept:'application/json'}});if(r.status===429)return say(${JSON.stringify(PRINT_COPY.limited)});if(!r.ok)return say(${JSON.stringify(PRINT_COPY.failed)});location.reload()}catch{say(${JSON.stringify(PRINT_COPY.failed)})}};
// Records a redraw. A staff session also needs its CSRF token; a holder's link does not.
const drawn=async(staff)=>{try{const h={};if(staff){const s=await (await fetch('/api/v1/session',{credentials:'same-origin'})).json();h['x-csrf-token']=s.csrfToken}await fetch(location.pathname+'/drawn'+location.search,{method:'POST',credentials:'same-origin',headers:h,keepalive:true})}catch{}};
const ask=(which)=>{for(const c of document.querySelectorAll('[data-confirm]'))c.hidden=c.dataset.confirm!==which};
document.addEventListener('click',(e)=>{const b=e.target.closest('[data-act]');if(!b)return;const a=b.dataset.act;
if(a==='print'){window.print();if(b.dataset.drawn)drawn(b.dataset.drawn==='staff')}
else if(a==='make')post('');
else if(a==='reprint'||a==='void')ask(a);
else if(a==='cancel')ask('');
else if(a==='yes')post(b.dataset.path||'')});
})();</script>`;

const button = (
  act: string,
  label: string,
  icon: Parameters<typeof iconHtml>[0],
  primary = false,
  extra = '',
) =>
  `<button class="btn${primary ? '' : ' outline'}" type="button" data-act="${act}"${extra}>${iconHtml(icon)}${escapeHtml(label)}</button>`;

const confirm = (which: 'reprint' | 'void', text: string, path: string) =>
  `<div class="pp-confirm" data-confirm="${which}" role="group" aria-label="${escapeHtml(text)}" hidden><p>${escapeHtml(text)}</p><button class="btn" type="button" data-act="yes" data-path="${path}">${escapeHtml(PRINT_COPY.confirmYes)}</button><button class="btn outline" type="button" data-act="cancel">${escapeHtml(PRINT_COPY.cancel)}</button></div>`;

export interface PrintPageProps {
  model: PrintPageModel;
  audience: PrintAudience;
  /** The holder's way back to the pass page. */
  backHref?: string;
  /** The PDF of the active print. */
  pdfHref?: string;
  /** Where the template's images are served (ends in `/`): `/p/{token}/assets/` for a holder. */
  assetBase?: string;
  /** Appended to staff URLs that a browser opens, so a Test pass is read in Test mode: `?mode=test`. */
  modeQuery?: string;
  nonce: string;
  theme?: PageTheme;
  /** The org's brand kit (`orgBrandOf`): its logo leads the bar, its accent colours the page, its mark sets the foot. */
  brand?: OrgBrand;
}

const HEAD =
  '<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">';

type Ready = Extract<PrintPageModel, { state: 'ready' }>;

/** The sheet, drawn with the print's own number and time and the template's images. */
function sheetHtml(props: PrintPageProps, model: Ready) {
  const { assetBase } = props;
  const url = (name: string | undefined) =>
    assetBase && name
      ? `${assetBase}${encodeURIComponent(name)}${props.modeQuery ?? ''}`
      : undefined;
  return renderToStaticMarkup(
    <PaperTicket
      content={model.content}
      design={model.design}
      code={model.code}
      drawing={drawPaperCode(toSvg, model.design.barcode, model.code)}
      mode={model.mode}
      mark={model.mark}
      issued={{ generation: model.generation, at: new Date(model.printedAt).toISOString() }}
      assets={{ logo: url(model.files.logo), art: url(model.files.art) }}
    />,
  );
}

/** Print first, then the PDF; a holder can also reprint or void. All before the sheet in reading order. */
function actionsHtml(props: PrintPageProps) {
  const holder = props.audience === 'holder';
  const actions = [
    button(
      'print',
      PRINT_COPY.print,
      Printer,
      true,
      ` data-drawn="${holder ? 'holder' : 'staff'}"`,
    ),
    ...(props.pdfHref
      ? [
          `<a class="btn outline" href="${escapeHtml(props.pdfHref)}" download>${iconHtml(Download)}${escapeHtml(PRINT_COPY.download)}</a>`,
        ]
      : []),
    ...(holder
      ? [button('reprint', PRINT_COPY.reprint, RotateCcw), button('void', PRINT_COPY.void, Ban)]
      : []),
  ].join('');
  const lossy =
    props.model.state === 'ready' && hasUndrawable(props.model.content)
      ? `<p class="callout pp-lossy" data-lossy>${iconHtml(TriangleAlert)}<span>${escapeHtml(PRINT_COPY.lossy)}</span></p>`
      : '';
  const stale =
    props.model.state === 'ready' && props.model.stale
      ? `<p class="callout pp-lossy" data-stale>${iconHtml(TriangleAlert)}<span>${escapeHtml(holder ? PRINT_COPY.staleHolder : PRINT_COPY.stale)}</span></p>`
      : '';
  return `${stale}${lossy}<div class="pp-actions">${actions}</div>${
    holder
      ? `${confirm('reprint', PRINT_COPY.confirmReprint, '/reprint')}${confirm('void', PRINT_COPY.confirmVoid, '/void')}`
      : ''
  }<p class="pp-error callout" role="alert" data-error hidden></p>`;
}

/** The body under the title: the two states and the ready sheet, for both audiences. */
function stateBody(props: PrintPageProps): { body: string; sheet: boolean } {
  const { model } = props;
  const holder = props.audience === 'holder';
  const back = props.backHref
    ? `<div class="pp-back">${actionHtml({ label: PRINT_COPY.back, href: props.backHref })}</div>`
    : '';
  if (model.state === 'unavailable')
    return {
      sheet: false,
      body: `<div class="pp-unavailable" role="status"><p>${escapeHtml(PRINT_COPY.unavailableLine(model.orgName))}</p></div>${back}`,
    };
  if (model.state === 'empty')
    return {
      sheet: false,
      body: `<div class="pp-empty pp-stage"><p>${escapeHtml(model.again ? PRINT_COPY.againNote : holder ? PRINT_COPY.noPrint : PRINT_COPY.noPrintStaff)}</p>${
        holder
          ? `<div class="pp-actions">${button('make', model.again ? PRINT_COPY.again : PRINT_COPY.make, Printer, true)}</div>`
          : ''
      }<p class="pp-error callout" role="alert" data-error hidden></p></div>${back}`,
    };
  return {
    sheet: true,
    body: `<div class="pp-stage">${actionsHtml(props)}${sheetHtml(props, model)}</div>${back}`,
  };
}

/** The holder's page: the org's bar, the title, the lede and actions, then the sheet. */
function holderPage(props: PrintPageProps): string {
  const { model } = props;
  const { body, sheet } = stateBody(props);
  const heading = model.state === 'unavailable' ? PRINT_COPY.unavailable : PRINT_COPY.title;
  // The buddy shows only in a state: looking over an empty page, tugging at a locked one.
  const art =
    model.state === 'unavailable'
      ? stateArtHtml('no-access')
      : model.state === 'empty'
        ? renderToStaticMarkup(<BuddyArt mood="curious" scene="inspect" size="xl" playOnLoad />)
        : '';
  const bar = renderToStaticMarkup(
    <div className="pp-noprint">
      <OrgBar orgName={model.orgName} brand={props.brand} />
      <div className="pp-ribbon">
        <TestRibbon mode={model.mode} what="pass" />
      </div>
    </div>,
  );
  const page = model.state === 'ready' ? pageRule(model.design.size, model.design.sheet) : '';
  const mark = renderToStaticMarkup(
    <div className="pp-noprint">
      <OrgMark brand={props.brand} />
    </div>,
  );
  const lede = sheet ? `<p class="pp-lede">${escapeHtml(PRINT_COPY.lede)}</p>` : '';
  const pair = model.state === 'unavailable' ? ' pp-scene-pair' : '';
  const scene = art ? `<div class="scene pp-scene${pair}" aria-hidden="true">${art}</div>` : '';
  return `${documentStart(props.theme)}${HEAD}<title>${escapeHtml(heading)}</title><style nonce="${props.nonce}">${HOLDER_CSS}\n${ORG_SHELL_CSS}\n${page}\n${PRINT_ONLY_CSS}${brandCss(props.brand)}</style></head><body><div class="[--wl-gutter:1rem] sm:[--wl-gutter:1.5rem]">${bar}<main class="pp-main">${scene}<div class="pp-head"><h1>${escapeHtml(heading)}</h1>${lede}</div>${body}</main>${mark}</div>${SCRIPT(props.nonce)}</body></html>`;
}

/**
 * The print page. A holder gets the org's bar and the ticket; staff keep the hosted PassBook shell.
 * The code appears only in the sheet's barcode geometry and its typed line.
 */
export function renderPrintPage(props: PrintPageProps): string {
  const { model } = props;
  if (props.audience === 'holder') return holderPage(props);
  const strip = renderToStaticMarkup(<TestRibbon mode={model.mode} what="pass" />);
  const ribbon = strip ? `<div class="pp-ribbon">${strip}</div>` : '';
  const { body, sheet } = stateBody(props);
  const page = model.state === 'ready' ? pageRule(model.design.size, model.design.sheet) : '';
  return hostedPage({
    nonce: props.nonce,
    ...(props.theme ? { theme: props.theme } : {}),
    ...(props.brand ? { brand: props.brand } : {}),
    title: model.state === 'unavailable' ? PRINT_COPY.unavailable : PRINT_COPY.staffTitle,
    art: model.state === 'unavailable' ? 'no-access' : 'login',
    ...(sheet ? { lede: escapeHtml(PRINT_COPY.lede) } : {}),
    wide: true,
    ...(model.state === 'unavailable' ? { replay: false } : {}),
    css: `${PAGE_CSS}\n${page}\n${PRINT_ONLY_CSS}`,
    head: HEAD,
    body: `${ribbon}${body}`,
    after: SCRIPT(props.nonce),
  });
}
