import type { ImageSlot } from '../../passkit/types.ts';
import type { ImageView } from './types.ts';

export const IMAGE_SLOTS: readonly ImageSlot[] = [
  'icon',
  'logo',
  'primaryLogo',
  'secondaryLogo',
  'strip',
  'thumbnail',
  'artwork',
  'background',
  'footer',
];

/** Only URLs a browser can load without running anything or leaking the page. */
export function safeImageUrl(url: string): boolean {
  return /^(https:\/\/|\/(?!\/)|data:image\/(png|jpeg|gif|webp);base64,)/i.test(url.trim());
}

const FILE = /^(?:([A-Za-z0-9_-]+)\.lproj\/)?([A-Za-z0-9]+?)(?:@([23])x)?\.png$/;

function langOf(tag: string): string {
  return (tag.split(/[-_]/)[0] ?? tag).toLowerCase();
}

/**
 * Pick the files for each slot. A top-level file overrides localized ones (Apple's rule);
 * otherwise the exact locale folder, then the language-only folder.
 */
export function resolveImages(
  assets: Record<string, string>,
  locale: string,
): Partial<Record<ImageSlot, ImageView>> {
  const found = new Map<ImageSlot, { folder: string; scale: 1 | 2 | 3; url: string }[]>();
  for (const [name, url] of Object.entries(assets)) {
    const m = FILE.exec(name);
    const slot = m?.[2] as ImageSlot | undefined;
    if (!m || !slot || !IMAGE_SLOTS.includes(slot) || !safeImageUrl(url)) continue;
    const list = found.get(slot) ?? [];
    list.push({ folder: m[1] ?? '', scale: m[3] ? (Number(m[3]) as 2 | 3) : 1, url });
    found.set(slot, list);
  }
  const out: Partial<Record<ImageSlot, ImageView>> = {};
  const want = locale.toLowerCase().replace(/_/g, '-');
  for (const [slot, files] of found) {
    const folders = [...new Set(files.map((f) => f.folder))];
    const folder =
      folders.find((f) => f === '') ??
      folders.find((f) => f.toLowerCase().replace(/_/g, '-') === want) ??
      folders.find((f) => langOf(f) === langOf(want)) ??
      folders.sort()[0];
    const chosen = files.filter((f) => f.folder === folder).sort((a, b) => a.scale - b.scale);
    const first = chosen[0];
    if (!first) continue;
    out[slot] = {
      slot,
      src: first.url,
      ...(chosen.length > 1 || first.scale > 1
        ? { srcset: chosen.map((f) => `${f.url} ${f.scale}x`).join(', ') }
        : {}),
    };
  }
  return out;
}
