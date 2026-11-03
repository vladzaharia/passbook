// The 1200×630 social image (public/og-image.png): the sign-in band (src/worker/ssr/hosted.ts) at
// poster size. The wordmark sits on the card's left text inset, centred on the buddy's face; the
// buddy sits on the card's top edge at the right; the card carries the foil edge and the line.
// Laid out at 400×210 CSS px and shot at 3×, so the art's lines keep their weight.
import { ICON_COLORS } from './icon-art.ts';

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_SCALE = 3;
export const OG_ALT = 'The PassBook buddy, a smiling pocket holding three passes, beside the name.';

/** The dark tokens the art and the mark read (src/worker/ssr/theme.ts). */
const DARK =
  '--raised:#0d111b;--sunken:#020408;--strong:#fff;--line-strong:#61697b;--accent:#2dd4bf;--accent-on:#04201c;--foil-1:#2dd4bf;--foil-2:#9a5cff;--foil-3:#ffc24d';

/** CSS px. The art is 96×72 units: its base is y 66 (1/12 up) and its face 21 units above that. */
const ART_W = 144;
const ART_H = 108;
const EDGE = 24;
const INSET = 24;
const CARD_TOP = 132;
/** The pocket's right edge (x 80.75 of 96) lines up with the card's right text inset. */
const ART_RIGHT_SPACE = (15.25 / 96) * ART_W;

export interface OgParts {
  /** WalletArt markup, seated, still. */
  art: string;
  /** BrandMark markup. */
  mark: string;
  /** ART_CSS plus the mark's sheet. */
  css: string;
  /** Rubik as a data: URI. */
  font: string;
  description: string;
}

export function ogHtml(p: OgParts): string {
  const w = OG_SIZE.width / OG_SCALE;
  const h = OG_SIZE.height / OG_SCALE;
  const overlap = ART_H / 12;
  const face = (21 / 72) * ART_H;
  return `<!doctype html><html><head><style>
@font-face{font-family:Rubik;font-weight:300 900;src:url(${p.font}) format("woff2")}
${p.css}
:root{${DARK}}
html,body{margin:0;background:${ICON_COLORS.page}}
.stage{position:relative;width:${w}px;height:${h}px;overflow:hidden;font-family:Rubik,sans-serif}
.band{position:absolute;left:${EDGE}px;right:${EDGE}px;top:0;height:${CARD_TOP + overlap}px;display:flex;align-items:flex-end;justify-content:space-between;padding-inline:${INSET + 1}px ${INSET - ART_RIGHT_SPACE}px;box-sizing:border-box}
.brand{display:flex;align-items:center;gap:14px;height:${2 * face}px;margin-bottom:${overlap}px;font-size:28px;font-weight:600;letter-spacing:-.015em;color:#fff}
.brand svg{width:34px;height:34px;color:var(--accent)}
.scene{position:relative;z-index:2}
.scene .wl-art{width:${ART_W}px;height:${ART_H}px}
.card{position:absolute;left:${EDGE}px;right:${EDGE}px;top:${CARD_TOP}px;height:${h}px;overflow:hidden;border:1px solid #212633;border-radius:14px;background:${ICON_COLORS.tile};box-shadow:inset 0 1px 0 rgb(255 255 255/.05)}
.card::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(115deg,var(--foil-1),var(--foil-2) 55%,var(--foil-3))}
.card p{margin:22px ${INSET}px 0;font-size:15px;line-height:20px;color:#b5bed3}
</style></head><body><div class="stage"><div class="card"><p>${p.description}</p></div><div class="band"><div class="brand">${p.mark}PassBook</div><div class="scene">${p.art}</div></div></div></body></html>`;
}
