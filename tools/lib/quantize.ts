// Reduces an RGBA image to at most `size` colours, deterministically: median cut on the
// premultiplied colours weighted by pixel count, then a few k-means rounds. No dithering: flat art
// keeps clean edges and compresses better.
import type { Image } from './png.ts';

type Color = [number, number, number, number];
interface Entry {
  key: number;
  /** Premultiplied RGBA: transparent pixels are one colour whatever their RGB. */
  p: Color;
  count: number;
}

const premultiply = (r: number, g: number, b: number, a: number): Color => [
  (r * a) / 255,
  (g * a) / 255,
  (b * a) / 255,
  a,
];
const distance = (x: Color, y: Color) =>
  (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2 + (x[3] - y[3]) ** 2;

function mean(entries: Entry[]): Color {
  const sum: Color = [0, 0, 0, 0];
  let total = 0;
  for (const e of entries) {
    for (let c = 0; c < 4; c++) sum[c] = (sum[c] as number) + (e.p[c] as number) * e.count;
    total += e.count;
  }
  return sum.map((v) => v / total) as Color;
}

/** Splits the box with the widest weighted channel range at its weighted median. */
function medianCut(entries: Entry[], size: number): Entry[][] {
  const boxes = [entries];
  while (boxes.length < size) {
    let pick = -1;
    let channel = 0;
    let widest = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const weight = box.reduce((s, e) => s + e.count, 0);
      for (let c = 0; c < 4; c++) {
        const values = box.map((e) => e.p[c] as number);
        const range = (Math.max(...values) - Math.min(...values)) * Math.sqrt(weight);
        if (range > widest) [widest, pick, channel] = [range, i, c];
      }
    });
    if (pick < 0) break;
    const box = (boxes[pick] as Entry[]).sort(
      (a, b) => (a.p[channel] as number) - (b.p[channel] as number),
    );
    const half = box.reduce((s, e) => s + e.count, 0) / 2;
    let seen = 0;
    let cut = 1;
    for (; cut < box.length - 1; cut++) {
      seen += (box[cut - 1] as Entry).count;
      if (seen >= half) break;
    }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes;
}

export function quantize(image: Image, size = 256): Image {
  const { data } = image;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const unique = new Map<number, Entry>();
  for (let i = 0; i < data.length; i += 4) {
    const key = view.getUint32(i);
    const entry = unique.get(key);
    if (entry) entry.count++;
    else {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]] as Color;
      unique.set(key, { key, p: premultiply(r, g, b, a), count: 1 });
    }
  }
  const entries = [...unique.values()];
  if (entries.length <= size) return image;
  let centers = medianCut(entries, size).map(mean);
  const nearest = (p: Color) => {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    centers.forEach((c, i) => {
      const d = distance(p, c);
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best;
  };
  let assign: number[] = [];
  for (let round = 0; round < 6; round++) {
    assign = entries.map((e) => nearest(e.p));
    const groups = centers.map((): Entry[] => []);
    for (const [i, e] of entries.entries()) groups[assign[i] as number]?.push(e);
    centers = groups.map((g, i) => (g.length ? mean(g) : (centers[i] as Color)));
  }
  assign = entries.map((e) => nearest(e.p));
  const palette = centers.map(([r, g, b, a]) => {
    const alpha = Math.round(a);
    const un = (v: number) => (alpha ? Math.min(255, Math.round((v * 255) / alpha)) : 0);
    return [un(r), un(g), un(b), alpha] as Color;
  });
  const mapped = new Map(entries.map((e, i) => [e.key, palette[assign[i] as number] as Color]));
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) out.set(mapped.get(view.getUint32(i)) as Color, i);
  return { ...image, data: out };
}
