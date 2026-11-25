/** The photo-led card: badge, credential and ID. Positions come from the inline boxes (badge-layout.ts). */
export const BADGE_CSS = `.pp-bd-front{background:var(--org);color:var(--org-fg)}
.pp-bd-front>*{position:absolute}
.pp-bd-front .pp-bd-kicker{font-size:calc(var(--mm) * 1.9);font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--org-label);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.pp-bd-front .pp-bd-name{font-weight:600;line-height:1.1;display:-webkit-box;-webkit-line-clamp:var(--lines,2);-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.pp-bd-front .pp-bd-role{font-size:calc(var(--mm) * 2.8);font-weight:500;line-height:1.2;display:-webkit-box;-webkit-line-clamp:var(--lines,1);-webkit-box-orient:vertical;overflow:hidden}
.pp-bd-front .pp-bd-details{font-size:calc(var(--mm) * 2.3);line-height:1.35;color:var(--org-fg);overflow:hidden}
.pp-bd-front .pp-bd-details div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-mono-ink.pp-bd-front{background:#fff;color:var(--ink)}
.pp-mono-ink.pp-bd-front .pp-bd-kicker{color:var(--muted)}
.pp-mono-ink.pp-bd-front .pp-bd-details{color:var(--ink)}
.pp-bd-back{background:#fff}
.pp-bd-back>*{position:absolute}
.pp-bd-back .pp-bd-code{display:flex;align-items:center;justify-content:center}
.pp-bd-back .pp-bd-note{display:flex;flex-direction:column;gap:calc(var(--mm) * 1.4)}
.pp-bd-back .pp-lbl{font-size:calc(var(--mm) * 1.7639)}
.pp-bd-back .pp-mono{display:block;font-size:calc(var(--mm) * 2.54);font-weight:700;letter-spacing:.03em;word-spacing:.25em;color:var(--ink)}
.pp-bd-back .pp-typed{text-align:center}
.pp-bd-back p{font-size:calc(var(--mm) * 2.1167);line-height:1.3}
.pp-bd-back .pp-bd-meta{margin-top:auto;display:flex;flex-direction:column;gap:calc(var(--mm) * 0.4);font-size:calc(var(--mm) * 1.905);color:var(--muted);border-top:calc(var(--mm) * 0.2) solid var(--hair);padding-top:calc(var(--mm) * 1)}
.pp-bd-back .pp-bd-meta .pp-passbook{font-size:calc(var(--mm) * 1.905);align-self:flex-end}`;
