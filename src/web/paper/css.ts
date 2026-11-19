import { PAPER_SPECS, type PaperSize } from '../../passkit/template/paper.ts';

/**
 * The printed sheet. Black on white, no tints: a paper ticket is read by a scanner and by tired
 * eyes. Lengths are `calc(var(--mm) * n)`: on screen --mm is the sheet's width over its width in
 * mm, so the preview scales as one piece; in print it is 1mm and the sheet is its true size.
 */
export const PAPER_CSS = `.pp-fit{container-type:inline-size;width:100%;aspect-ratio:var(--w)/var(--h)}
.pp-sheet{--mm:calc(100cqw / var(--w));--ink:#000;--paper:#fff;position:relative;display:grid;box-sizing:border-box;width:100%;height:100%;overflow:hidden;background:var(--paper);color:var(--ink);font-family:var(--pk-font-sans,system-ui,sans-serif);line-height:1.2;border-radius:calc(var(--mm) * 1.5);box-shadow:0 0 0 1px rgb(0 0 0/.14),0 8px 24px rgb(0 0 0/.18)}
.pp-sheet *{box-sizing:border-box;margin:0}
.pp-head{grid-area:head;display:flex;align-items:center;justify-content:space-between;gap:calc(var(--mm) * 4);border-bottom:calc(var(--mm) * .5) solid var(--ink);padding-bottom:calc(var(--mm) * 3)}
.pp-brand{font-weight:700;letter-spacing:.06em;text-transform:uppercase;overflow-wrap:anywhere}
.pp-type{flex:none;border:calc(var(--mm) * .4) solid var(--ink);border-radius:calc(var(--mm) * 1);padding:calc(var(--mm) * .8) calc(var(--mm) * 2.4);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.pp-body{grid-area:body;display:flex;flex-direction:column;min-width:0}
.pp-event{font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere}
.pp-when,.pp-venue{overflow-wrap:anywhere}
.pp-when{font-weight:600}
.pp-info{display:grid;grid-template-columns:repeat(auto-fit,minmax(calc(var(--mm) * 34),1fr));gap:calc(var(--mm) * 3) calc(var(--mm) * 5)}
.pp-info dt{font-size:calc(var(--mm) * 3);font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.pp-info dd{margin:0;font-size:calc(var(--mm) * 5);font-weight:700;overflow-wrap:anywhere}
.pp-code-block{grid-area:code;display:flex;min-width:0}
.pp-figure{flex:none;background:var(--paper);line-height:0}
.pp-figure svg{display:block;color:var(--ink)}
.pp-code-text{display:flex;flex-direction:column;min-width:0}
.pp-code-label{font-size:calc(var(--mm) * 3);font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.pp-code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-weight:700;letter-spacing:.04em;overflow-wrap:anywhere;word-spacing:.3em}
.pp-note{font-size:calc(var(--mm) * 3.4)}
.pp-missing{font-weight:700}
.pp-terms{grid-area:terms;border-top:calc(var(--mm) * .3) solid var(--ink);padding-top:calc(var(--mm) * 3);font-size:calc(var(--mm) * 3);line-height:1.35;overflow-wrap:anywhere}
.pp-a4,.pp-letter{grid-template:"head" auto "body" auto "code" 1fr "terms" auto/1fr;padding:calc(var(--mm) * 16);gap:calc(var(--mm) * 9)}
.pp-a4 .pp-brand,.pp-letter .pp-brand{font-size:calc(var(--mm) * 4.6)}
.pp-a4 .pp-type,.pp-letter .pp-type{font-size:calc(var(--mm) * 4)}
.pp-a4 .pp-body,.pp-letter .pp-body{gap:calc(var(--mm) * 3)}
.pp-a4 .pp-event,.pp-letter .pp-event{font-size:calc(var(--mm) * 11);line-height:1.08}
.pp-a4 .pp-when,.pp-letter .pp-when{font-size:calc(var(--mm) * 6)}
.pp-a4 .pp-venue,.pp-letter .pp-venue{font-size:calc(var(--mm) * 5)}
.pp-a4 .pp-info,.pp-letter .pp-info{margin-top:calc(var(--mm) * 6)}
.pp-a4 .pp-code-block,.pp-letter .pp-code-block{gap:calc(var(--mm) * 8);align-items:center;align-self:center}
.pp-a4 .pp-code-text,.pp-letter .pp-code-text{gap:calc(var(--mm) * 2)}
.pp-a4 .pp-code,.pp-letter .pp-code{font-size:calc(var(--mm) * 5.2)}
.pp-half{grid-template:"head code" auto "body code" 1fr "terms code" auto/1fr auto;padding:calc(var(--mm) * 10);gap:calc(var(--mm) * 5) calc(var(--mm) * 10)}
.pp-half .pp-brand{font-size:calc(var(--mm) * 3.6)}
.pp-half .pp-type{font-size:calc(var(--mm) * 3.2)}
.pp-half .pp-body{gap:calc(var(--mm) * 2)}
.pp-half .pp-event{font-size:calc(var(--mm) * 8.5)}
.pp-half .pp-when{font-size:calc(var(--mm) * 4.6)}
.pp-half .pp-venue{font-size:calc(var(--mm) * 4)}
.pp-half .pp-info{margin-top:calc(var(--mm) * 3);grid-template-columns:repeat(auto-fit,minmax(calc(var(--mm) * 28),1fr))}
.pp-half .pp-info dd{font-size:calc(var(--mm) * 4.2)}
.pp-half .pp-code-block,.pp-cr80 .pp-code-block{flex-direction:column;align-items:center;justify-content:center;gap:calc(var(--mm) * 2);text-align:center}
.pp-half .pp-code-text,.pp-cr80 .pp-code-text{align-items:center}
.pp-half .pp-code{font-size:calc(var(--mm) * 3.6);max-width:calc(var(--mm) * 50)}
.pp-half .pp-terms{font-size:calc(var(--mm) * 2.6)}
.pp-cr80{grid-template:"head code" auto "body code" 1fr/1fr auto;padding:calc(var(--mm) * 3.5);gap:calc(var(--mm) * 2) calc(var(--mm) * 3)}
.pp-cr80 .pp-head{padding-bottom:calc(var(--mm) * 1.2);border-bottom-width:calc(var(--mm) * .3)}
.pp-cr80 .pp-brand{font-size:calc(var(--mm) * 2.3)}
.pp-cr80 .pp-body{gap:calc(var(--mm) * .8)}
.pp-cr80 .pp-event{font-size:calc(var(--mm) * 3.9);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pp-cr80 .pp-when{font-size:calc(var(--mm) * 2.5)}
.pp-cr80 .pp-venue{font-size:calc(var(--mm) * 2.3)}
.pp-cr80 .pp-info{margin-top:calc(var(--mm) * 1);gap:calc(var(--mm) * 1);grid-template-columns:1fr}
.pp-cr80 .pp-info dt{display:none}
.pp-cr80 .pp-info dd{font-size:calc(var(--mm) * 2.6);line-height:1.15}
.pp-cr80 .pp-code{font-size:calc(var(--mm) * 2.4);max-width:calc(var(--mm) * 40)}
.pp-cr80 .pp-code-label,.pp-cr80 .pp-note,.pp-cr80 .pp-terms{display:none}
@media print{
.pp-fit{container-type:normal;width:calc(var(--w) * 1mm);height:calc(var(--h) * 1mm);aspect-ratio:auto}
.pp-sheet{--mm:1mm;border-radius:0;box-shadow:none;break-inside:avoid;print-color-adjust:exact;-webkit-print-color-adjust:exact}
}`;

/** `@page` for one size; the sheet fills the page, so the margin is 0. */
export function pageRule(size: PaperSize): string {
  const s = PAPER_SPECS[size];
  return `@page{size:${s.widthMm}mm ${s.heightMm}mm;margin:0}`;
}
