import type { z } from 'zod';
import { GOAL_MAX, GOAL_MIN } from '@/passkit/stamps/layout.ts';
import type { TemplateVersionDetailSchema } from '@/shared/contracts/index.ts';
import { contrast, type Rgb, toRgbText } from '../templates/designer/contrast.ts';
import { placeImage, setSlotImage } from '../templates/designer/images.ts';
import { type DesignDoc, type DraftAsset, isRecord } from '../templates/designer/model.ts';
import { readStamps, setGoal } from '../templates/designer/stamps.ts';

/** A saved version as the designer's documents (the designer's own `docOf`, without its page). */
export function docOfVersion(v: z.infer<typeof TemplateVersionDetailSchema>): DesignDoc {
  return {
    passJson: structuredClone(v.passJson),
    manifest: structuredClone(v.manifest) as Record<string, unknown>,
    assets: v.assets.map((a) => ({
      name: a.name,
      slot: a.slot,
      scale: a.scale,
      size: a.size,
      width: a.width,
      height: a.height,
      sha1: a.sha1,
    })),
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
});

/** Text in whichever of white and black reads better; labels a step softer when that still reads. */
export function textColors(bg: Rgb): { foreground: Rgb; label: Rgb } {
  const foreground = contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK;
  const soft = mix(foreground, bg, 0.28);
  return { foreground, label: contrast(soft, bg) >= 3 ? soft : foreground };
}

/** The common codes lead; the rest are the ISO codes the browser's money formatting knows. */
const COMMON = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'SEK'];
const currencies = (): string[] => {
  const known =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [];
  return [...COMMON, ...known];
};

type Dict = Record<string, unknown>;
const currencyNode = (doc: DesignDoc): Dict | null => {
  const props = isRecord(doc.manifest.inputs) ? doc.manifest.inputs.properties : null;
  const node = isRecord(props) ? props.currency : null;
  return isRecord(node) && node.type === 'string' ? node : null;
};
/** A code the input accepts: three capitals, and its pattern when it has one. */
const acceptable = (node: Dict, code: string) =>
  /^[A-Z]{3}$/.test(code) &&
  (typeof node.pattern !== 'string' || new RegExp(node.pattern).test(code));

export interface Choices {
  goal?: { value: number; min: number; max: number };
  currency?: { value: string; options: string[] };
}

/** The two choices a blueprint can offer: stamps to fill, and the currency. */
export function choicesOf(doc: DesignDoc): Choices {
  const out: Choices = {};
  const stamps = readStamps(doc);
  if (stamps) out.goal = { value: stamps.goal, min: GOAL_MIN, max: GOAL_MAX };
  const node = currencyNode(doc);
  if (node) {
    const own = typeof node.default === 'string' ? node.default : 'USD';
    const options = [...new Set([own, ...currencies()])].filter((c) => acceptable(node, c));
    out.currency = { value: own, options };
  }
  return out;
}

function withCurrency(doc: DesignDoc, code: string): DesignDoc {
  const next = structuredClone(doc);
  const node = currencyNode(next);
  if (!node || !acceptable(node, code)) return doc;
  node.default = code;
  if (Array.isArray(node.enum) && !node.enum.includes(code)) node.enum.push(code);
  if (isRecord(node['x-enumLabels'])) node['x-enumLabels'][code] ??= code;
  if (isRecord(next.manifest.sample)) next.manifest.sample.currency = code;
  return next;
}

export interface QuickSetup {
  goal?: number | undefined;
  currency?: string | undefined;
  name: string;
  color?: Rgb | undefined;
  logo?: DraftAsset | undefined;
}

/** The blueprint as the org's template: its own name, colours and logo, never the blueprint flag. */
export function brandDoc(base: DesignDoc, setup: QuickSetup): DesignDoc {
  const { blueprint: _flag, org: _org, ...manifest } = base.manifest;
  let doc: DesignDoc = { ...base, manifest: { ...manifest, name: setup.name } };
  if (setup.color) {
    const { foreground, label } = textColors(setup.color);
    doc = {
      ...doc,
      passJson: {
        ...doc.passJson,
        backgroundColor: toRgbText(setup.color),
        foregroundColor: toRgbText(foreground),
        labelColor: toRgbText(label),
      },
    };
  }
  if (setup.goal !== undefined) doc = setGoal(doc, setup.goal);
  if (setup.currency !== undefined) doc = withCurrency(doc, setup.currency);
  return setup.logo ? setSlotImage(doc, 'logo', setup.logo) : doc;
}

/** A logo box is 50-160 pt wide and 50 pt high at most; the @2x box is the one a free image fits. */
const FIT = { width: 320, height: 100 };

async function redraw(blob: Blob): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const k = Math.min(FIT.width / bitmap.width, FIT.height / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
    return out ? new Uint8Array(await out.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** A dropped logo as the logo slot's file: as it is when it fits, else scaled into the box. */
export async function placeLogo(
  file: Blob,
): Promise<{ ok: true; asset: DraftAsset } | { ok: false; message: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const placed = placeImage('logo', bytes);
  if (placed.ok) return placed;
  const scaled = await redraw(file);
  const again = scaled ? placeImage('logo', scaled) : null;
  return again?.ok ? again : placed;
}

/** Up to three strong colours of a logo, most common first. Empty when the browser cannot read it. */
export async function logoColors(file: Blob): Promise<Rgb[]> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(bitmap, 0, 0, 40, 40);
    const { data } = ctx.getImageData(0, 0, 40, 40);
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      // Transparent, grey and near-white or near-black pixels are not a brand colour.
      if (a < 128 || spread < 40 || Math.max(r, g, b) < 40) continue;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      buckets.set(key, { n: cur.n + 1, r: cur.r + r, g: cur.g + g, b: cur.b + b });
    }
    const found = [...buckets.values()]
      .sort((x, y) => y.n - x.n)
      .map((v) => ({
        r: Math.round(v.r / v.n),
        g: Math.round(v.g / v.n),
        b: Math.round(v.b / v.n),
      }));
    const out: Rgb[] = [];
    for (const c of found) {
      if (out.every((o) => Math.abs(o.r - c.r) + Math.abs(o.g - c.g) + Math.abs(o.b - c.b) > 120))
        out.push(c);
      if (out.length === 3) break;
    }
    return out;
  } catch {
    return [];
  }
}
