/** Permit, coupon and card layouts, from the approved mockups. */
export const SMALL_CSS = `.pp-pm{--org:rgb(170,28,44);--org-label:rgb(255,210,212)}
.pp-pm .pp-pm-band{position:absolute;left:calc(var(--mm) * 8);right:calc(var(--mm) * 8);top:calc(var(--mm) * 8);height:calc(var(--mm) * 19);border-radius:calc(var(--mm) * 3);background:var(--org);color:#fff;display:flex;align-items:center;gap:calc(var(--mm) * 3);padding:0 calc(var(--mm) * 5)}
.pp-pm .pp-pm-band .pp-pm-org{font-size:calc(var(--mm) * 3.5278);font-weight:600}
.pp-pm .pp-pm-band .pp-pm-kind{margin-left:auto;text-align:right}
.pp-pm .pp-pm-band .pp-pm-kind .pp-pm-k{font-size:calc(var(--mm) * 2.3283);font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--org-label)}
.pp-pm .pp-pm-band .pp-pm-kind .pp-pm-t{font-size:calc(var(--mm) * 5.2917);font-weight:600;line-height:1.05}
.pp-pm .pp-pm-main{position:absolute;left:calc(var(--mm) * 8);right:calc(var(--mm) * 8);top:calc(var(--mm) * 31);height:calc(var(--mm) * 84);display:grid;grid-template-columns:calc(var(--mm) * 44) 1fr calc(var(--mm) * 54);gap:calc(var(--mm) * 6)}
.pp-pm .pp-pm-zone{background:var(--org);color:#fff;border-radius:calc(var(--mm) * 3);display:flex;flex-direction:column;align-items:center;justify-content:center}
.pp-pm .pp-pm-zone .pp-pm-k{font-size:calc(var(--mm) * 3.8806);font-weight:600;letter-spacing:.16em;color:var(--org-label)}
.pp-pm .pp-pm-zone .pp-pm-v{font-size:calc(var(--mm) * 39.5111);font-weight:700;line-height:.95}
.pp-pm .pp-pm-mid{display:flex;flex-direction:column;justify-content:center;gap:calc(var(--mm) * 4.5);min-width:0}
.pp-pm .pp-pm-plate-no{font-size:calc(var(--mm) * 12.7);font-weight:700;line-height:1;letter-spacing:.03em;color:var(--ink);border:calc(var(--mm) * 0.6) solid var(--ink);border-radius:calc(var(--mm) * 2.5);padding:calc(var(--mm) * 2) calc(var(--mm) * 3.5);align-self:flex-start;white-space:nowrap}
.pp-pm .pp-pm-until{font-size:calc(var(--mm) * 7.7611);font-weight:700;line-height:1.05;color:var(--ink)}
.pp-pm .pp-pm-row{display:flex;gap:calc(var(--mm) * 8);white-space:nowrap}
.pp-pm .pp-pm-row .pp-pm-v{font-size:calc(var(--mm) * 4.2333);font-weight:600;color:var(--ink)}
.pp-pm .pp-pm-side{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;border-left:calc(var(--mm) * 0.3) solid var(--hair);padding-left:calc(var(--mm) * 2)}
.pp-pm .pp-pm-side .pp-mono{display:block;max-width:calc(var(--mm) * 36);font-size:calc(var(--mm) * 2.8222);line-height:1.35;font-weight:700;letter-spacing:.03em;word-spacing:.25em;margin-top:calc(var(--mm) * 0.6);color:var(--ink)}
.pp-pm .pp-pm-foot{position:absolute;left:calc(var(--mm) * 8);right:calc(var(--mm) * 8);bottom:calc(var(--mm) * 8);height:calc(var(--mm) * 17);border-top:calc(var(--mm) * 0.3) solid var(--hair);padding-top:calc(var(--mm) * 2.4);display:flex;justify-content:space-between;gap:calc(var(--mm) * 6)}
.pp-pm .pp-pm-foot .pp-pm-how{font-size:calc(var(--mm) * 3.175);font-weight:600;color:var(--ink);max-width:calc(var(--mm) * 105)}
.pp-pm .pp-pm-foot .pp-pm-how span{display:block;font-weight:400;font-size:calc(var(--mm) * 2.6811);color:var(--muted);margin-top:calc(var(--mm) * 0.6)}
.pp-pm .pp-pm-foot .pp-pm-meta{text-align:right;font-size:calc(var(--mm) * 2.3989);color:var(--muted);display:flex;flex-direction:column;justify-content:space-between}
.pp-cp{--org:rgb(181,64,0)}
.pp-cp .pp-cp-cut{position:absolute;inset:calc(var(--mm) * 8);border:calc(var(--mm) * 0.45) dashed var(--rule);border-radius:calc(var(--mm) * 3.5)}
.pp-cp .pp-cp-scissors{position:absolute;left:calc(var(--mm) * 16);top:calc(var(--mm) * 5.6);background:#fff;padding:0 calc(var(--mm) * 1.2);width:calc(var(--mm) * 7.2);height:calc(var(--mm) * 5);color:var(--muted)}
.pp-cp .pp-cp-inner{position:absolute;inset:calc(var(--mm) * 10.5);display:grid;grid-template-rows:calc(var(--mm) * 50) 1fr auto;gap:calc(var(--mm) * 4)}
.pp-cp .pp-cp-band{position:relative;border-radius:calc(var(--mm) * 2.5);overflow:hidden;background:var(--org);color:#fff;padding:calc(var(--mm) * 4) calc(var(--mm) * 5);display:flex;align-items:flex-start;gap:calc(var(--mm) * 2.6)}
.pp-cp .pp-cp-band img.pp-cp-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:right center}
.pp-cp .pp-cp-band>*:not(.pp-cp-bg){position:relative}
.pp-cp .pp-cp-band .pp-cp-org{font-size:calc(var(--mm) * 3.5278);font-weight:600;line-height:calc(var(--mm) * 9)}
.pp-cp .pp-cp-band .pp-cp-kind{margin-left:auto;font-size:calc(var(--mm) * 2.3283);font-weight:500;letter-spacing:.08em;text-transform:uppercase;line-height:calc(var(--mm) * 9);color:rgb(255,238,221)}
.pp-cp .pp-cp-body{display:grid;grid-template-columns:1fr calc(var(--mm) * 97);gap:calc(var(--mm) * 6);min-height:0}
.pp-cp .pp-cp-offer{display:flex;flex-direction:column;justify-content:center;gap:calc(var(--mm) * 3.5);min-width:0}
.pp-cp .pp-cp-offer .pp-cp-v{font-size:calc(var(--mm) * 19.7556);font-weight:700;line-height:.95;white-space:nowrap;letter-spacing:-.02em;color:var(--org)}
.pp-cp .pp-cp-offer .pp-cp-s{font-size:calc(var(--mm) * 5.6);font-weight:500;color:var(--ink)}
.pp-cp .pp-cp-use{display:inline-flex;align-self:flex-start;gap:calc(var(--mm) * 2);align-items:baseline;border:calc(var(--mm) * 0.4) solid var(--ink);border-radius:calc(var(--mm) * 1.5);padding:calc(var(--mm) * 1.2) calc(var(--mm) * 2.4);font-size:calc(var(--mm) * 4.6);font-weight:600;color:var(--ink);margin-top:calc(var(--mm) * 1)}
.pp-cp .pp-cp-use .pp-lbl{color:var(--ink)}
.pp-cp .pp-cp-code{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.pp-cp .pp-cp-code .pp-mono{display:block;font-size:calc(var(--mm) * 3.175);font-weight:700;letter-spacing:.04em;word-spacing:.3em;margin-top:calc(var(--mm) * 0.6);color:var(--ink)}
.pp-cp .pp-cp-bottom .pp-buddy{position:absolute;right:calc(var(--mm) * 4);bottom:100%;margin-bottom:calc(var(--mm) * -1.1)}
.pp-cp .pp-cp-bottom{position:relative;display:flex;justify-content:space-between;align-items:flex-end;gap:calc(var(--mm) * 8);border-top:calc(var(--mm) * 0.25) solid var(--hair);padding-top:calc(var(--mm) * 2)}
.pp-cp .pp-cp-bottom p{font-size:calc(var(--mm) * 2.54);color:var(--muted);line-height:1.35;max-width:calc(var(--mm) * 120)}
.pp-cp .pp-cp-bottom p b{color:var(--ink);font-weight:600}
.pp-cp .pp-cp-bottom .pp-cp-meta{text-align:right;font-size:calc(var(--mm) * 2.3283);color:var(--muted);white-space:nowrap}
.pp-card{--org:rgb(6,12,27);--org-fg:rgb(255,249,242);--org-label:rgb(210,180,157)}
.pp-cd-front{background:var(--org);color:var(--org-fg)}
.pp-cd-front .pp-cd-bgart{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.28}
.pp-cd-front .pp-cd-shade{position:absolute;inset:0;background:linear-gradient(90deg,var(--org) 30%,rgba(6,12,27,.55) 100%)}
.pp-cd-front .pp-cd-l{position:absolute;left:calc(var(--mm) * 4);top:calc(var(--mm) * 4);bottom:calc(var(--mm) * 4);width:calc(var(--mm) * 37);display:flex;flex-direction:column}
.pp-cd-front .pp-cd-l img{width:calc(var(--mm) * 24);height:auto;display:block}
.pp-cd-front .pp-cd-k{font-size:calc(var(--mm) * 1.7639);font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--org-label)}
.pp-cd-front .pp-cd-name{font-size:calc(var(--mm) * 3.5278);font-weight:600;line-height:1.1;margin-top:calc(var(--mm) * 0.6);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.pp-cd-front .pp-cd-tier{font-size:calc(var(--mm) * 2.3283);margin-top:calc(var(--mm) * 0.8);color:var(--org-fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pp-cd-front .pp-cd-grow{flex:1}
.pp-cd-front .pp-cd-tile{position:absolute;right:calc(var(--mm) * 3.4);top:50%;transform:translateY(-50%);background:#fff;border-radius:calc(var(--mm) * 2);line-height:0;overflow:hidden}
.pp-cd-back{background:#fff}
.pp-cd-back .pp-cd-in{position:absolute;inset:calc(var(--mm) * 3.6) calc(var(--mm) * 4);display:flex;flex-direction:column;gap:calc(var(--mm) * 1.4)}
.pp-cd-back .pp-cd-row{display:flex;align-items:center;gap:calc(var(--mm) * 2)}
.pp-cd-back .pp-cd-row img{width:calc(var(--mm) * 15);height:auto;filter:brightness(.55)}
.pp-cd-back .pp-cd-row .pp-cd-org{margin-left:auto;font-size:calc(var(--mm) * 1.9756);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.pp-cd-back .pp-lbl{font-size:calc(var(--mm) * 1.7639)}
.pp-cd-back .pp-mono{display:block;font-size:calc(var(--mm) * 2.54);font-weight:700;letter-spacing:.03em;word-spacing:.25em;color:var(--ink)}
.pp-cd-back p{font-size:calc(var(--mm) * 2.1167);line-height:1.3}
.pp-cd-back .pp-cd-meta{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;font-size:calc(var(--mm) * 1.905);color:var(--muted);border-top:calc(var(--mm) * 0.2) solid var(--hair);padding-top:calc(var(--mm) * 1)}
.pp-cd-back .pp-cd-meta .pp-passbook{font-size:calc(var(--mm) * 1.905)}`;
