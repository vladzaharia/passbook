import {
  PAPER_SPECS,
  type PaperSheet,
  type PaperSize,
  sheetApplies,
} from '../../passkit/template/paper.ts';
import bandCss from '../pass-card/test-band.css?raw';
import { FULL_CSS, HALF_FULL_CSS } from './css-full.ts';
import { SIZES_CSS } from './css-sizes.ts';
import { SMALL_CSS } from './css-small.ts';
import { FALLBACK_FAMILY, FALLBACK_FONT_CSS } from './fallback-font.ts';

const MM_PER_PT = 0.352778;
const pt = (n: number) => `calc(var(--mm) * ${+(n * MM_PER_PT).toFixed(4)})`;
const mm = (n: number) => `calc(var(--mm) * ${n})`;

/**
 * The printed sheet. White paper, black ink, the pass colours only in the band. Lengths are
 * `calc(var(--mm) * n)`: on screen --mm is the sheet's width over its width in mm, so the preview
 * scales as one piece; in print it is 1mm and the sheet is its true size. Paper never goes dark:
 * these are print tokens, not theme tokens.
 */
const BASE_CSS = `${FALLBACK_FONT_CSS}
.pp-fit{position:relative;container-type:inline-size;width:100%;aspect-ratio:var(--w)/var(--h)}
.pp-fit+.pp-fit{margin-top:12px}
.pp-sheet{--mm:calc(100cqw / var(--w));--ink:#000;--text:#14171F;--muted:#4A5163;--rule:#9CA3B1;--hair:#C9CED8;--wash:#F1F3F7;position:relative;display:block;box-sizing:border-box;width:100%;height:100%;overflow:hidden;background:#fff;color:var(--text);font-family:Rubik,"${FALLBACK_FAMILY}",var(--pk-font-sans,system-ui,sans-serif);font-size:${pt(9)};line-height:1.3;font-variant-numeric:tabular-nums;border-radius:${mm(1.5)};box-shadow:0 0 0 1px rgb(0 0 0/.14),0 8px 24px rgb(0 0 0/.18)}
.pp-sheet *{box-sizing:border-box;margin:0;padding:0}
.pp-sheet h2{color:inherit}
.pp-mono{font-family:var(--pk-font-mono,"JetBrains Mono",ui-monospace,Menlo,monospace)}
.pp-lbl{font-size:${pt(6.6)};font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.pp-qr,.pp-bar{display:block}
.pp-plate{display:grid;place-items:center;flex:none;border-radius:${mm(2)};overflow:hidden}
.pp-plate img{width:78%;height:78%;object-fit:contain}
.pp-plate svg{width:62%;height:62%}
.pp-passbook{font-size:${pt(6.4)};color:var(--muted);letter-spacing:.01em}
.pp-passbook b{font-weight:600;color:var(--text)}
.pp-missing{font-weight:700;color:var(--ink)}
.pp-fig{line-height:0;background:#fff}
.pp-top-half{container-type:inline-size;aspect-ratio:210/148}
.pp-top-half .pp-sheet{box-shadow:none;border-radius:0}
.pp-fit:has(>.pp-top-half){background:#fff;box-shadow:0 0 0 1px rgb(0 0 0/.14),0 8px 24px rgb(0 0 0/.18);border-radius:${mm(1.5)}}
.pp-pm:not(.pp-mono-ink) .pp-pm-band .pp-plate,.pp-cp:not(.pp-mono-ink) .pp-cp-band .pp-plate{background:rgb(0 0 0/.18)!important}
.pp-pm-nozone{grid-template-columns:1fr ${mm(54)}!important}
.pp-mono-ink.pp-cd-front{background:#fff;color:var(--ink)}
.pp-mono-ink .pp-cd-k,.pp-mono-ink .pp-cd-tier{color:var(--muted)}
.pp-mono-ink .pp-cd-tile{outline:${mm(0.35)} solid var(--ink)}
.pp-mono-ink .pp-pm-band,.pp-mono-ink .pp-pm-zone,.pp-mono-ink .pp-cp-band{background:#fff;color:var(--ink);border:${mm(0.35)} solid var(--ink)}
.pp-mono-ink .pp-pm-zone .pp-pm-zk,.pp-mono-ink .pp-pm-kind .pp-pm-k,.pp-mono-ink .pp-cp-kind{color:var(--muted)}
.pp-mono-ink .pp-cp-v{color:var(--ink)}
@media print{
.pp-fit:has(>.pp-top-half){box-shadow:none;border-radius:0}
.pp-top-half{container-type:normal;width:210mm;height:148mm;aspect-ratio:auto}
.pp-fit{container-type:normal;width:calc(var(--w) * 1mm);height:calc(var(--h) * 1mm);aspect-ratio:auto;break-after:page;break-inside:avoid}
.pp-fit+.pp-fit{margin-top:0}
.pp-fit:last-child{break-after:auto}
.pp-sheet{--mm:1mm;border-radius:0;box-shadow:none;print-color-adjust:exact;-webkit-print-color-adjust:exact}
}`;

export const PAPER_CSS = `${BASE_CSS}\n${FULL_CSS}\n${HALF_FULL_CSS}\n${SMALL_CSS}\n${SIZES_CSS}\n${bandCss}`;

/** `@page` for one size, or for the home sheet a card or strip prints on; the sheet fills the page, so the margin is 0. */
export function pageRule(size: PaperSize, sheet?: PaperSheet): string {
  const s = PAPER_SPECS[sheet && sheetApplies(size) ? sheet : size];
  return `@page{size:${s.widthMm}mm ${s.heightMm}mm;margin:0}`;
}
