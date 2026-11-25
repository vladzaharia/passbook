/** The A4 / Letter / half-sheet ticket: door panel, holder panel, "before you go". Ported from the approved mockups. */
export const FULL_CSS = `.pp-sheet{--org:#333;--org-fg:#fff;--org-label:#ddd;--inset:8}
.pp-tk{position:absolute;left:calc(var(--mm) * var(--inset));right:calc(var(--mm) * var(--inset));top:calc(var(--mm) * var(--inset));height:calc(calc(var(--mm) * var(--half)) - 2 * calc(var(--mm) * var(--inset)));display:grid;grid-template-columns:1fr 1fr;border:calc(var(--mm) * 0.3) solid var(--rule);border-radius:calc(var(--mm) * 4)}
.pp-tk::before,.pp-tk::after{content:"";position:absolute;left:50%;width:calc(var(--mm) * 7);height:calc(var(--mm) * 7);margin-left:calc(var(--mm) * -3.5);border-radius:50%;background:#fff;border:calc(var(--mm) * 0.3) solid var(--rule);z-index:2}
.pp-tk::before{top:calc(var(--mm) * -3.65);clip-path:inset(50% 0 0 0)}
.pp-tk::after{bottom:calc(var(--mm) * -3.65);clip-path:inset(0 0 50% 0)}
.pp-perf{position:absolute;left:50%;top:calc(var(--mm) * 4);bottom:calc(var(--mm) * 4);border-left:calc(var(--mm) * 0.35) dashed var(--hair)}
.pp-door{position:relative;display:flex;flex-direction:column;align-items:center;padding:calc(var(--mm) * 6) calc(var(--mm) * 7) calc(var(--mm) * 5.5);min-width:0}
.pp-door-head{align-self:stretch;display:flex;gap:calc(var(--mm) * 3);align-items:center}
.pp-door-head .pp-plate{width:calc(var(--mm) * 11);height:calc(var(--mm) * 11);background:var(--org)}
.pp-door-head .pp-who{min-width:0}
.pp-door-head .pp-org{font-size:calc(var(--mm) * 2.4694);font-weight:500;color:var(--muted);letter-spacing:.02em}
.pp-door-head .pp-title{font-size:calc(var(--mm) * 4.0569);font-weight:600;line-height:1.15;color:var(--ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pp-door-when{align-self:stretch;margin-top:calc(var(--mm) * 2.2);font-size:calc(var(--mm) * 3.175);font-weight:500;color:var(--ink)}
.pp-door-code{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:0}
.pp-door-code .pp-typed{margin-top:calc(var(--mm) * 0.6);text-align:center}
.pp-door-code .pp-typed .pp-mono{display:block;margin-top:calc(var(--mm) * 0.8);font-size:calc(var(--mm) * 3.7042);font-weight:700;letter-spacing:.04em;word-spacing:.35em;color:var(--ink)}
.pp-door-rows{align-self:stretch;display:flex;gap:calc(var(--mm) * 4);border-top:calc(var(--mm) * 0.25) solid var(--hair);padding-top:calc(var(--mm) * 2.4)}
.pp-door-rows>div{min-width:0;flex:1 0 auto}
.pp-door-rows>div.pp-wide,.pp-fact.pp-wide{flex-shrink:1;overflow:hidden}
.pp-door-rows .pp-v{font-size:calc(var(--mm) * 3.3514);font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-face{position:relative;display:flex;flex-direction:column;min-width:0;border-radius:0 calc(var(--mm) * 3.7) calc(var(--mm) * 3.7) 0;overflow:hidden}
.pp-band{flex:none;position:relative;height:calc(var(--mm) * var(--band,44));background:var(--org);color:var(--org-fg);padding:calc(var(--mm) * 5.5) calc(var(--mm) * 6.5);display:flex;flex-direction:column;justify-content:space-between;overflow:hidden}
.pp-band .pp-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:var(--art-pos,center);opacity:var(--art-o,1)}
.pp-band .pp-fade{position:absolute;inset:0;background:linear-gradient(90deg,var(--org) 0%,var(--org) 38%,transparent 100%)}
.pp-band .pp-top,.pp-band .pp-bottom{position:relative}
.pp-band .pp-top{display:flex;align-items:center;gap:calc(var(--mm) * 2.4)}
.pp-band .pp-top .pp-plate{width:calc(var(--mm) * 9);height:calc(var(--mm) * 9)}
.pp-band .pp-top .pp-org{font-size:calc(var(--mm) * 2.8222);font-weight:600;letter-spacing:.02em}
.pp-band .pp-kicker{font-size:calc(var(--mm) * 2.3283);font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--org-label)}
.pp-band h2{font-size:calc(var(--mm) * var(--ts,6.7028));line-height:1.08;font-weight:600;letter-spacing:-.01em;margin-top:calc(var(--mm) * 1);max-width:80%;display:-webkit-box;-webkit-line-clamp:var(--tl,2);-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.pp-band .pp-has-photo h2{max-width:calc(100% - calc(var(--mm) * 31))}
.pp-photo{display:block;flex:none;object-fit:cover;object-position:50% 22%;border-radius:calc(var(--mm) * 2);background:var(--wash)}
.pp-band .pp-band-photo{position:absolute;right:calc(var(--mm) * 6.5);bottom:calc(var(--mm) * 5.5)}
.pp-initials{display:grid;place-items:center;background:var(--org);color:var(--org-fg);font-weight:600;letter-spacing:.02em;line-height:1;border:calc(var(--mm) * 0.4) solid var(--org-fg)}
.pp-mono-ink .pp-initials{background:#fff;color:var(--ink);border-color:var(--ink)}
.pp-mono-ink .pp-photo{filter:none}
.pp-face-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:calc(var(--mm) * 3.2);padding:calc(var(--mm) * 5) calc(var(--mm) * 6.5) calc(var(--mm) * 5.5)}
.pp-big,.pp-sub{flex:none;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.pp-big{font-size:calc(var(--mm) * 4.5861);font-weight:600;color:var(--ink);line-height:1.2}
.pp-sub{font-size:calc(var(--mm) * 3.3514);color:var(--text)}
.pp-face-lines{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:calc(var(--mm) * 3.2)}
.pp-facts{display:flex;flex-shrink:0;gap:calc(var(--mm) * 2)}
.pp-fact{flex:1 0 auto;min-width:0;border:calc(var(--mm) * 0.3) solid var(--hair);border-radius:calc(var(--mm) * 2);padding:calc(var(--mm) * 1.8) calc(var(--mm) * 2.4)}
.pp-fact .pp-v{font-size:calc(var(--mm) * 5.2917);font-weight:600;color:var(--ink);line-height:1.1;margin-top:calc(var(--mm) * 0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-fact .pp-lbl,.pp-door-rows .pp-lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-chip{display:inline-block;border:calc(var(--mm) * 0.3) solid var(--ink);border-radius:calc(var(--mm) * 1.2);padding:calc(var(--mm) * 0.5) calc(var(--mm) * 1.8);font-size:calc(var(--mm) * 2.3989);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink)}
.pp-info{position:absolute;left:calc(var(--mm) * 12);right:calc(var(--mm) * 12);top:calc(calc(var(--mm) * var(--half)) + calc(var(--mm) * 9));bottom:calc(var(--mm) * 12);display:flex;flex-direction:column;gap:calc(var(--mm) * 5)}
.pp-info h2{font-size:calc(var(--mm) * 4.2333);font-weight:600;color:var(--ink)}
.pp-cols{display:grid;grid-template-columns:repeat(var(--cols,3),1fr);gap:calc(var(--mm) * 7)}
.pp-col h3{margin-bottom:calc(var(--mm) * 1.6)}
.pp-col p,.pp-col li{font-size:calc(var(--mm) * 3.175);line-height:1.4}
.pp-col p.pp-strong{font-weight:600;color:var(--ink)}
.pp-col ul{list-style:none}
.pp-col li{position:relative;padding-left:calc(var(--mm) * 3.6)}
.pp-col li::before{content:"";position:absolute;left:0;top:calc(var(--mm) * 1.55);width:calc(var(--mm) * 1.4);height:calc(var(--mm) * 1.4);border-radius:50%;background:var(--org-ink,var(--ink))}
.pp-col li.pp-box::before{top:calc(var(--mm) * 0.9);width:calc(var(--mm) * 2.6);height:calc(var(--mm) * 2.6);border-radius:calc(var(--mm) * 0.5);background:none;border:calc(var(--mm) * 0.3) solid var(--ink)}
.pp-col li.pp-box{padding-left:calc(var(--mm) * 4.6)}
.pp-rules{display:grid;grid-template-columns:repeat(var(--rules,3),1fr);gap:calc(var(--mm) * 6);background:var(--wash);border-radius:calc(var(--mm) * 2.5);padding:calc(var(--mm) * 3.2) calc(var(--mm) * 4)}
.pp-rules p{font-size:calc(var(--mm) * 2.9633);line-height:1.35}
.pp-rules b{display:block;font-weight:600;color:var(--ink)}
.pp-terms{font-size:calc(var(--mm) * 2.54);line-height:1.4;color:var(--muted)}
.pp-support{display:flex;flex-wrap:wrap;gap:calc(var(--mm) * 1) calc(var(--mm) * 6);font-size:calc(var(--mm) * 2.9633)}
.pp-support b{font-weight:600;color:var(--ink)}
.pp-foot{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;gap:calc(var(--mm) * 4);border-top:calc(var(--mm) * 0.25) solid var(--hair);padding-top:calc(var(--mm) * 2)}
.pp-foot .pp-meta{font-size:calc(var(--mm) * 2.3989);color:var(--muted)}
.pp-foot{position:relative}
.pp-foot .pp-buddy{position:absolute;right:calc(var(--mm) * 6);bottom:100%;margin-bottom:calc(var(--mm) * -1.1)}
.pp-fold{position:absolute;font-size:calc(var(--mm) * 1.905);color:var(--muted);letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:calc(var(--mm) * 1)}
.pp-fold.pp-h{top:calc(calc(var(--mm) * var(--half)) - calc(var(--mm) * 0.15))}
.pp-fold.pp-h::before{content:"";width:calc(var(--mm) * 4);border-top:calc(var(--mm) * 0.3) dashed var(--rule)}
.pp-fold.pp-h.pp-l{left:calc(var(--mm) * 7)}.pp-fold.pp-h.pp-r{right:calc(var(--mm) * 7);flex-direction:row-reverse}
.pp-fold.pp-v{left:50%;width:0;height:calc(var(--mm) * 4);border-left:calc(var(--mm) * 0.3) dashed var(--rule)}
.pp-fold.pp-v.pp-t{top:calc(var(--mm) * 2.5);display:none}.pp-fold.pp-v.pp-b{bottom:calc(var(--mm) * 7)}
.pp-mono-ink .pp-band{background:#fff;color:var(--ink);border-bottom:calc(var(--mm) * 0.35) solid var(--ink)}
.pp-mono-ink .pp-band .pp-kicker{color:var(--muted)}
.pp-mono-ink .pp-plate{background:#000!important}
.pp-mono-ink .pp-col li::before{background:var(--ink)}
.pp-mono-ink img{filter:grayscale(1)}
.pp-col li.pp-box::before,.pp-mono-ink .pp-col li.pp-box::before{background:none}
.pp-test .pp-tk{border-style:dashed;border-color:var(--ink)}
.pp-watermark{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:3;clip-path:polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,calc(var(--mm) * 8) calc(var(--mm) * 8),50% calc(var(--mm) * 8),50% calc(calc(var(--mm) * var(--half)) - calc(var(--mm) * 8)),calc(var(--mm) * 8) calc(calc(var(--mm) * var(--half)) - calc(var(--mm) * 8)),calc(var(--mm) * 8) calc(var(--mm) * 8))}
.pp-watermark span{position:absolute;left:-20%;width:140%;text-align:center;font-size:calc(var(--mm) * 15.5222);font-weight:700;letter-spacing:.12em;color:transparent;-webkit-text-stroke:calc(var(--mm) * 0.35) rgb(120 126 140/.75);transform:rotate(-24deg);white-space:nowrap}
.pp-test-strip{align-self:stretch;margin:calc(var(--mm) * -1) 0 calc(var(--mm) * 2);padding:calc(var(--mm) * 1.2) calc(var(--mm) * 2);border-radius:calc(var(--mm) * 1.2);font-size:calc(var(--mm) * 2.6106);font-weight:700;letter-spacing:.04em;text-align:center;color:var(--ink);background:repeating-linear-gradient(135deg,#fff 0 calc(var(--mm) * 1.6),#D5D9E1 calc(var(--mm) * 1.6) calc(var(--mm) * 3.2));border:calc(var(--mm) * 0.3) solid var(--ink)}
.pp-tk .pp-door,.pp-tk .pp-face{z-index:1}`;
/** Half sheet: no "before you go"; the footer row sits under the ticket. */
export const HALF_FULL_CSS = `.pp-info-half{top:auto;bottom:calc(var(--mm) * 8);height:calc(var(--mm) * 12);display:block}
.pp-info-half .pp-foot{margin-top:0;height:100%;align-items:center;border-top:0;gap:calc(var(--mm) * 3)}
.pp-info-half .pp-meta{order:1}.pp-info-half .pp-buddy{position:static;order:2;margin:0 0 0 auto}.pp-info-half .pp-passbook{order:3}
.pp-face-note{font-size:calc(var(--mm) * 2.6);line-height:1.35;color:var(--muted)}
.pp-face-note b{font-weight:600;color:var(--ink)}`;
