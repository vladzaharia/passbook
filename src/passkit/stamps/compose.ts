// Composites stamp art onto the strip at the grid positions (proposed home:
// src/passkit/stamps/compose.ts). Integer and IEEE + - * / arithmetic only; the tilt reads a
// literal cos/sin table, so the pixels are identical on every engine.
import { type Box, STRIP, STRIP_SAFE, type StampCell, stampGrid } from './layout.ts';
import type { Rgba } from './png.ts';

/** Bumped whenever the pixels can change: part of every cache key and of the version hash. */
export const COMPOSITOR_VERSION = 1;

/**
 * Stamp art: square images; the stamp fills the middle two thirds, the outer third is room for
 * rays, specks and the tilt. Filled and empty are required. The reward slot falls back to empty
 * until earned; once earned to `rewardEarned`, else `filled` under `reward`, else `filled`.
 */
export interface StampArt {
  filled: Rgba;
  empty: Rgba;
  reward?: Rgba;
  rewardEarned?: Rgba;
}

export interface StripRequest {
  goal: number;
  /** Stamps on the card; values above the goal draw a full card. */
  count: number;
  scale: 2 | 3;
  /**
   * The template's own strip at this scale. Without one the strip is transparent, so the pass
   * colour (an org's brand colour included) shows through.
   */
  base: Rgba | { color: [number, number, number] } | 'transparent';
  art: StampArt;
  tilt?: boolean;
  box?: Box;
}

const ART_SPAN = 1.5;

// cos, sin for -12..12 degrees (index = degrees + 12).
const ROT: [number, number][] = [
  [0.97814760073380569, -0.20791169081775931],
  [0.98162718344766398, -0.1908089953765448],
  [0.98480775301220802, -0.17364817766693033],
  [0.98768834059513777, -0.15643446504023087],
  [0.99026806874157036, -0.13917310096006544],
  [0.99254615164132198, -0.12186934340514748],
  [0.99452189536827329, -0.10452846326765346],
  [0.99619469809174555, -0.087155742747658166],
  [0.9975640502598242, -0.069756473744125302],
  [0.99862953475457383, -0.052335956242943828],
  [0.99939082701909576, -0.034899496702500969],
  [0.99984769515639127, -0.017452406437283512],
  [1, 0],
  [0.99984769515639127, 0.017452406437283512],
  [0.99939082701909576, 0.034899496702500969],
  [0.99862953475457383, 0.052335956242943828],
  [0.9975640502598242, 0.069756473744125302],
  [0.99619469809174555, 0.087155742747658166],
  [0.99452189536827329, 0.10452846326765346],
  [0.99254615164132198, 0.12186934340514748],
  [0.99026806874157036, 0.13917310096006544],
  [0.98768834059513777, 0.15643446504023087],
  [0.98480775301220802, 0.17364817766693033],
  [0.98162718344766398, 0.1908089953765448],
  [0.97814760073380569, 0.20791169081775931],
];

/** Premultiplied mip chain of one piece of art, box-filtered by halves. */
interface Mip {
  w: number;
  h: number;
  p: Float64Array;
}
const mips = new WeakMap<Rgba, Mip[]>();

function mipChain(img: Rgba): Mip[] {
  const hit = mips.get(img);
  if (hit) return hit;
  const p = new Float64Array(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    const a = (img.data[i * 4 + 3] as number) / 255;
    p[i * 4] = (img.data[i * 4] as number) * a;
    p[i * 4 + 1] = (img.data[i * 4 + 1] as number) * a;
    p[i * 4 + 2] = (img.data[i * 4 + 2] as number) * a;
    p[i * 4 + 3] = a * 255;
  }
  const chain: Mip[] = [{ w: img.width, h: img.height, p }];
  for (
    let last = chain[0] as Mip;
    last.w > 8 && last.h > 8;
    last = chain[chain.length - 1] as Mip
  ) {
    const w = last.w >> 1;
    const h = last.h >> 1;
    const q = new Float64Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 4; c++) {
          const at = (yy: number, xx: number) => last.p[(yy * last.w + xx) * 4 + c] as number;
          q[(y * w + x) * 4 + c] =
            (at(2 * y, 2 * x) +
              at(2 * y, 2 * x + 1) +
              at(2 * y + 1, 2 * x) +
              at(2 * y + 1, 2 * x + 1)) /
            4;
        }
    chain.push({ w, h, p: q });
  }
  mips.set(img, chain);
  return chain;
}

/** A rendered piece of art for one cell: premultiplied RGBA floats over a pixel rectangle. */
interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
  p: Float64Array;
}

/** Resamples art for one cell: rotate, scale through the mip chain, 2 x 2 samples per pixel. */
function patchOf(art: Rgba, cell: StampCell, s: number, nudge: boolean, tilt: number): Patch {
  const chain = mipChain(art);
  const span = cell.d * ART_SPAN * s;
  let m = chain[0] as Mip;
  for (const c of chain) if (c.w >= span) m = c;
  const k = m.w / span;
  const [cos, sin] = ROT[Math.max(-12, Math.min(12, tilt)) + 12] as [number, number];
  const cx = (cell.cx + (nudge ? cell.jx : 0)) * s;
  const cy = (cell.cy + (nudge ? cell.jy : 0)) * s;
  const half = span * 0.75; // covers the rotated square
  const x = Math.floor(cx - half);
  const y = Math.floor(cy - half);
  const w = Math.ceil(cx + half) - x;
  const h = Math.ceil(cy + half) - y;
  const p = new Float64Array(w * h * 4);
  const mw = m.w;
  const mh = m.h;
  const src = m.p;
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const dx = x + px + 0.25 + sx * 0.5 - cx;
          const dy = y + py + 0.25 + sy * 0.5 - cy;
          const u = (dx * cos + dy * sin) * k + mw / 2 - 0.5;
          const v = (-dx * sin + dy * cos) * k + mh / 2 - 0.5;
          if (u <= -1 || v <= -1 || u >= mw || v >= mh) continue;
          const x0 = Math.floor(u);
          const y0 = Math.floor(v);
          const fx = u - x0;
          const fy = v - y0;
          for (let j = 0; j < 2; j++) {
            const yy = y0 + j;
            if (yy < 0 || yy >= mh) continue;
            const wy = j ? fy : 1 - fy;
            for (let i = 0; i < 2; i++) {
              const xx = x0 + i;
              if (xx < 0 || xx >= mw) continue;
              const wgt = (i ? fx : 1 - fx) * wy;
              const o = (yy * mw + xx) * 4;
              r += (src[o] as number) * wgt;
              g += (src[o + 1] as number) * wgt;
              b += (src[o + 2] as number) * wgt;
              a += (src[o + 3] as number) * wgt;
            }
          }
        }
      const o = (py * w + px) * 4;
      p[o] = r / 4;
      p[o + 1] = g / 4;
      p[o + 2] = b / 4;
      p[o + 3] = a / 4;
    }
  return { x, y, w, h, p };
}

/** Premultiplied source-over of a patch onto the canvas. */
function blit(dst: Rgba, patch: Patch): void {
  const { data, width, height } = dst;
  for (let py = 0; py < patch.h; py++) {
    const ty = patch.y + py;
    if (ty < 0 || ty >= height) continue;
    for (let px = 0; px < patch.w; px++) {
      const tx = patch.x + px;
      if (tx < 0 || tx >= width) continue;
      const q = (py * patch.w + px) * 4;
      const a = (patch.p[q + 3] as number) / 255;
      if (a <= 0) continue;
      const o = (ty * width + tx) * 4;
      const da = (data[o + 3] as number) / 255;
      const outA = a + da * (1 - a);
      for (let c = 0; c < 3; c++)
        data[o + c] = Math.round(
          ((patch.p[q + c] as number) + (data[o + c] as number) * da * (1 - a)) / outA,
        );
      data[o + 3] = Math.round(outA * 255);
    }
  }
}

/** Patches per (art, cell, scale): a version's strips share them, so each is resampled once. */
const patches = new WeakMap<Rgba, Map<string, Patch>>();
function cached(art: Rgba, cell: StampCell, s: number, nudge: boolean, tilt: number): Patch {
  let byKey = patches.get(art);
  if (!byKey) {
    byKey = new Map();
    patches.set(art, byKey);
  }
  const key = `${cell.index}/${cell.cx}/${cell.cy}/${cell.d}/${s}/${nudge}/${tilt}`;
  let hit = byKey.get(key);
  if (!hit) {
    hit = patchOf(art, cell, s, nudge, tilt);
    byKey.set(key, hit);
  }
  return hit;
}

function drawArt(
  dst: Rgba,
  art: Rgba,
  cell: StampCell,
  s: number,
  nudge: boolean,
  tilt: number,
): void {
  blit(dst, cached(art, cell, s, nudge, tilt));
}

function baseCanvas(base: StripRequest['base'], scale: 2 | 3): Rgba {
  const width = STRIP.w * scale;
  const height = STRIP.h * scale;
  if (base === 'transparent') return { width, height, data: new Uint8Array(width * height * 4) };
  if ('color' in base) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([...base.color, 255], i * 4);
    return { width, height, data };
  }
  if (base.width !== width || base.height !== height)
    throw new RangeError(`The strip must be ${width} x ${height} px at @${scale}x.`);
  return { width, height, data: base.data.slice() };
}

/** One strip: the base, then every disc in grid order (empty, filled, reward, earned). */
export function renderStrip(req: StripRequest): Rgba {
  const grid = stampGrid(req.goal, req.box ?? STRIP_SAFE);
  const out = baseCanvas(req.base, req.scale);
  const count = Math.max(0, Math.min(req.count, req.goal));
  const tilt = req.tilt ?? true;
  for (const cell of grid.cells) {
    const on = cell.index < count;
    const deg = tilt ? cell.tilt : 0;
    if (cell.reward) {
      const { filled, empty, reward, rewardEarned } = req.art;
      if (!on) drawArt(out, reward ?? empty, cell, req.scale, false, 0);
      else if (rewardEarned) drawArt(out, rewardEarned, cell, req.scale, false, 0);
      else {
        drawArt(out, filled, cell, req.scale, false, 0);
        if (reward) drawArt(out, reward, cell, req.scale, false, 0);
      }
    } else drawArt(out, on ? req.art.filled : req.art.empty, cell, req.scale, on, on ? deg : 0);
  }
  return out;
}
