import { Ban, Download, Printer, RotateCcw } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRINT_COPY } from '../../shared/copy/print.ts';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { PAPER_CSS, pageRule } from '../../web/paper/css.ts';
import { drawPaperCode } from '../../web/paper/drawing.ts';
import { PaperTicket } from '../../web/paper/ticket.tsx';
import type { PrintAudience, PrintPageModel } from '../modules/prints/page.ts';
import type { PageTheme } from './head.ts';
import { actionHtml, hostedPage } from './hosted.ts';
import { iconHtml } from './icon.ts';
import { RIBBON_CSS, TestRibbon } from './test-ribbon.tsx';
import { escapeHtml } from './theme.ts';

/** The code is in the page, so it is private and never cached or sent on in a referrer. */
export const PRINT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

/** Screen: the sheet on the hosted card. Print: the sheet alone, at its true size. */
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
.pp-empty p,.pp-unavailable p{margin:0}
${PAPER_CSS}`;

const PRINT_ONLY_CSS = `@media print{
html,body{background:#fff}
body{min-height:0;padding:0}
.band,.body>div:first-child,.body>a.btn,.pp-actions,.pp-confirm,.pp-error,.pp-empty,.pp-ribbon,.card::before{display:none!important}
.hosted,.hosted.wide{display:block;max-width:none;min-height:0;padding:0}
.card{display:block;overflow:visible;border:0;border-radius:0;background:#fff;box-shadow:none}
.body{display:block;padding:0}
}`;

const SCRIPT = (nonce: string) => `<script nonce="${nonce}">(()=>{
const err=document.querySelector('[data-error]');
const say=(m)=>{if(err){err.textContent=m;err.hidden=false}};
const post=async(path)=>{if(err)err.hidden=true;try{const r=await fetch(location.pathname+path,{method:'POST',credentials:'same-origin',headers:{accept:'application/json'}});if(r.status===429)return say(${JSON.stringify(PRINT_COPY.limited)});if(!r.ok)return say(${JSON.stringify(PRINT_COPY.failed)});location.reload()}catch{say(${JSON.stringify(PRINT_COPY.failed)})}};
const ask=(which)=>{for(const c of document.querySelectorAll('[data-confirm]'))c.hidden=c.dataset.confirm!==which};
document.addEventListener('click',(e)=>{const b=e.target.closest('[data-act]');if(!b)return;const a=b.dataset.act;
if(a==='print')window.print();
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
) =>
  `<button class="btn${primary ? '' : ' outline'}" type="button" data-act="${act}">${iconHtml(icon)}${escapeHtml(label)}</button>`;

const confirm = (which: 'reprint' | 'void', text: string, path: string) =>
  `<div class="pp-confirm" data-confirm="${which}" role="group" aria-label="${escapeHtml(text)}" hidden><p>${escapeHtml(text)}</p><button class="btn" type="button" data-act="yes" data-path="${path}">${escapeHtml(PRINT_COPY.confirmYes)}</button><button class="btn outline" type="button" data-act="cancel">${escapeHtml(PRINT_COPY.cancel)}</button></div>`;

export interface PrintPageProps {
  model: PrintPageModel;
  audience: PrintAudience;
  /** The holder's way back to the pass page. */
  backHref?: string;
  /** The PDF of the active print. */
  pdfHref?: string;
  nonce: string;
  theme?: PageTheme;
}

/** The print page. The code appears only in the sheet's barcode geometry and its typed line. */
export function renderPrintPage(props: PrintPageProps): string {
  const { model, audience } = props;
  const holder = audience === 'holder';
  const strip = renderToStaticMarkup(<TestRibbon mode={model.mode} what="pass" />);
  const ribbon = strip ? `<div class="pp-ribbon">${strip}</div>` : '';
  const back = props.backHref ? actionHtml({ label: PRINT_COPY.back, href: props.backHref }) : '';
  const title = holder ? PRINT_COPY.title : PRINT_COPY.staffTitle;
  if (model.state === 'unavailable') {
    return hostedPage({
      nonce: props.nonce,
      ...(props.theme ? { theme: props.theme } : {}),
      title: PRINT_COPY.unavailable,
      art: 'no-access',
      css: PAGE_CSS,
      replay: false,
      head: '<meta name="referrer" content="no-referrer">',
      body: `${ribbon}<div class="pp-unavailable" role="status"><p>${escapeHtml(PRINT_COPY.unavailableLine(model.orgName))}</p></div>${back}`,
    });
  }
  let body: string;
  let page = '';
  if (model.state === 'empty') {
    body = `${ribbon}<div class="pp-empty pp-stage"><p>${escapeHtml(holder ? PRINT_COPY.noPrint : PRINT_COPY.noPrintStaff)}</p>${
      holder
        ? `<div class="pp-actions">${button('make', PRINT_COPY.make, Printer, true)}</div>`
        : ''
    }<p class="pp-error callout" role="alert" data-error hidden></p></div>${back}`;
  } else {
    const drawing = drawPaperCode(toSvg, model.design.barcode, model.code);
    const sheet = renderToStaticMarkup(
      <PaperTicket
        content={model.content}
        design={model.design}
        code={model.code}
        drawing={drawing}
      />,
    );
    const actions = [
      button('print', PRINT_COPY.print, Printer, true),
      ...(props.pdfHref
        ? [
            `<a class="btn outline" href="${escapeHtml(props.pdfHref)}" download>${iconHtml(Download)}${escapeHtml(PRINT_COPY.download)}</a>`,
          ]
        : []),
      ...(holder
        ? [button('reprint', PRINT_COPY.reprint, RotateCcw), button('void', PRINT_COPY.void, Ban)]
        : []),
    ].join('');
    body = `${ribbon}<div class="pp-stage">${sheet}<div class="pp-actions">${actions}</div>${
      holder
        ? `${confirm('reprint', PRINT_COPY.confirmReprint, '/reprint')}${confirm('void', PRINT_COPY.confirmVoid, '/void')}`
        : ''
    }<p class="pp-error callout" role="alert" data-error hidden></p></div>${back}`;
    page = pageRule(model.design.size);
  }
  return hostedPage({
    nonce: props.nonce,
    ...(props.theme ? { theme: props.theme } : {}),
    title,
    art: 'login',
    ...(model.state === 'ready' ? { lede: escapeHtml(PRINT_COPY.lede) } : {}),
    wide: true,
    css: `${PAGE_CSS}\n${page}\n${PRINT_ONLY_CSS}`,
    head: '<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">',
    body,
    after: SCRIPT(props.nonce),
  });
}
