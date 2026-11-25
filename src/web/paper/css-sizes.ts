/** Strips (stub, ATB, A6, DL), the portrait card, cards on a home sheet and the half-letter fit. */
const mm = (n: string) => `calc(var(--mm) * ${n})`;
export const SIZES_CSS = `.pp-strip{--org:#333;--org-fg:#fff;--org-label:#ddd}
.pp-st{position:absolute;left:${mm('var(--si)')};top:${mm('var(--st)')};width:${mm('var(--sw)')};height:${mm('var(--sh)')};display:grid;grid-template-columns:1fr ${mm('var(--cw)')};border:${mm('0.3')} solid var(--rule);border-radius:${mm('4')};overflow:hidden}
.pp-st-text{background:var(--org);color:var(--org-fg);padding:${mm('var(--sp)')};display:flex;flex-direction:column;gap:${mm('1')};min-width:0;min-height:0;overflow:hidden}
.pp-st .pp-perf{left:auto;right:${mm('var(--cw)')};top:${mm('3')};bottom:${mm('3')};border-left-color:var(--rule)}
.pp-st-head{display:flex;align-items:center;gap:${mm('2.4')};margin-bottom:${mm('1.5')}}
.pp-st-head .pp-plate{width:${mm('var(--pl)')};height:${mm('var(--pl)')};background:rgb(0 0 0/.18)!important}
.pp-st-who{min-width:0}
.pp-st-brand{font-size:${mm('2.8')};font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-st-k{font-size:${mm('var(--k)')};font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--org-label);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-st-title{font-size:${mm('var(--t)')};line-height:1.1;font-weight:600;letter-spacing:-.01em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pp-st-when{font-size:${mm('var(--wh)')};font-weight:500}
.pp-st-venue,.pp-st-line{font-size:${mm('var(--ve)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-st-rows{margin-top:auto;display:flex;gap:${mm('2')}}
.pp-st-row{flex:1 0 auto;min-width:0;border:${mm('0.25')} solid currentColor;border-radius:${mm('1.6')};padding:${mm('1.2')} ${mm('2')}}
.pp-stk{flex-direction:column;gap:${mm('0.8')}}
.pp-st-row.pp-wide{flex-shrink:1;overflow:hidden}
.pp-st-row .pp-st-rl,.pp-st-row .pp-st-rv{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-stk .pp-st-row{flex:none;display:flex;gap:${mm('2')};align-items:baseline;border:0;border-radius:0;padding:0}
.pp-stk .pp-st-rl{flex:none;width:${mm('15')}}
.pp-stk .pp-st-rv{font-size:${mm('3.4')}}
.pp-st-rl{font-size:${mm('var(--rl)')};font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--org-label)}
.pp-st-rv{font-size:${mm('var(--rv)')};font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-st-text .pp-typed{margin-top:auto;display:flex;gap:${mm('2')};align-items:baseline;white-space:nowrap}
.pp-st-text .pp-typed .pp-lbl{font-size:${mm('1.9')};color:var(--org-label)}
.pp-st-text .pp-typed .pp-mono{font-size:${mm('var(--ty)')};font-weight:700;letter-spacing:.04em;word-spacing:.35em}
.pp-st-foot{display:flex;justify-content:space-between;align-items:baseline;gap:${mm('3')};font-size:${mm('var(--ft)')};color:var(--org-label)}
.pp-st-text .pp-st-rows+.pp-st-foot{margin-top:${mm('1.5')}}
.pp-st-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pp-st-foot .pp-passbook,.pp-st-foot .pp-passbook b{font-size:inherit;color:inherit;white-space:nowrap}
.pp-st-code{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;background:#fff}
.pp-st-code .pp-typed{margin-top:${mm('0.6')};text-align:center}
.pp-st-code .pp-typed .pp-mono{display:block;margin-top:${mm('0.8')};font-size:${mm('3.7')};font-weight:700;letter-spacing:.04em;word-spacing:.35em;color:var(--ink)}
.pp-cr80p.pp-cd-back .pp-cd-meta{flex-direction:column;align-items:stretch;gap:${mm('0.4')}}
.pp-cr80p.pp-cd-back .pp-cd-meta .pp-passbook{align-self:flex-end}
.pp-mono-ink .pp-st-text{background:#fff;color:var(--ink)}
.pp-mono-ink .pp-st-k,.pp-mono-ink .pp-st-rl,.pp-mono-ink .pp-st-foot,.pp-mono-ink .pp-st-text .pp-typed .pp-lbl{color:var(--muted)}
.pp-mono-ink .pp-st-head .pp-plate{background:#000!important}
.pp-mono-ink.pp-cd-front .pp-cd-k,.pp-mono-ink.pp-cd-front .pp-cd-tier{color:var(--muted)}
.pp-cd-front .pp-cd-l img{max-height:${mm('20')};object-fit:contain;object-position:left top}
.pp-cr80p.pp-cd-front .pp-cd-l img{max-height:${mm('16')}}
.pp-cr80p.pp-cd-front .pp-cd-tier{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pp-cr80p.pp-cd-front .pp-cd-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pp-cr80p.pp-cd-front .pp-cd-l{width:auto;right:${mm('4')};bottom:${mm('46.6')}}
.pp-cr80p.pp-cd-front .pp-cd-tile{right:auto;left:50%;top:auto;bottom:${mm('4')};transform:translateX(-50%)}
.pp-hs{--mm:calc(100cqw / var(--w));position:absolute;inset:0;background:#fff;overflow:hidden;border-radius:${mm('1.5')}}
.pp-slot{position:absolute;container-type:inline-size;left:${mm('var(--x)')};top:${mm('var(--y)')};width:${mm('var(--cw)')};height:${mm('var(--ch)')};box-shadow:0 0 0 1px rgb(0 0 0/.14)}
.pp-slot .pp-sheet{border-radius:0;box-shadow:none}
.pp-turned{transform:rotate(180deg)}
.pp-bleed{position:absolute;left:${mm('var(--x)')};top:${mm('var(--y)')};width:${mm('var(--cw)')};height:${mm('var(--ch)')}}
.pp-cuts{position:absolute;inset:0;width:100%;height:100%}
.pp-hfit{position:absolute;top:0;height:100%;container-type:inline-size}
.pp-hfit .pp-sheet{box-shadow:none;border-radius:0}
@media print{
.pp-hs{--mm:1mm;border-radius:0}
.pp-slot{container-type:normal;box-shadow:none}
.pp-hfit{container-type:normal}
.pp-hfit .pp-sheet{--mm:calc(1mm * var(--sc))}
}`;
