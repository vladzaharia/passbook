import { sha1Hex } from '../sign/sha1.ts';
import { renderStampFiles } from '../stamps/package.ts';
import type { AssetEntry, ImageSlot, PassJson, TemplateManifest } from '../types.ts';
import { stripBlock } from './counters.ts';
import { isWalletArtName } from './wallets/schema.ts';

const decoder = new TextDecoder();
const SLOTS: readonly ImageSlot[] = [
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
const IMAGE_NAME = /^(?:([\w-]+)\.lproj\/)?([A-Za-z]+)(?:@([23])x)?\.png$/;
/** A generated strip: `stamps/strips/<count>/strip@2x.png`. */
export const STAMP_STRIP = /^stamps\/strips\/(\d{1,2})\/strip@([23])x\.png$/;
const STRINGS_NAME = /^([\w-]+)\.lproj\/pass\.strings$/;
/** Files that live in a template package but are never signed into a pass. */
const NEVER_SHIPPED = new Set(['pass.json', 'wallet.template.json', 'tooling.json']);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Width and height from a PNG IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Classifies a package file name. Returns null for files that never ship. */
export function classifyAsset(
  name: string,
): Pick<AssetEntry, 'slot' | 'scale' | 'locale' | 'stamps'> | null {
  // `wallets/**` is art for other wallets: kept in the version, never signed into a pass.
  if (NEVER_SHIPPED.has(name) || isWalletArtName(name)) return null;
  const generated = STAMP_STRIP.exec(name);
  if (generated)
    return { slot: 'strip', scale: generated[2] === '3' ? 3 : 2, stamps: Number(generated[1]) };
  if (name.startsWith('stamps/') && name.endsWith('.png')) return { slot: 'source', scale: 1 };
  const strings = STRINGS_NAME.exec(name);
  if (strings) return { slot: 'strings', scale: 1, locale: strings[1] as string };
  const image = IMAGE_NAME.exec(name);
  const slot = image?.[2] as ImageSlot | undefined;
  if (image && slot && SLOTS.includes(slot)) {
    return {
      slot,
      scale: image[3] === '3' ? 3 : image[3] === '2' ? 2 : 1,
      ...(image[1] ? { locale: image[1] } : {}),
    };
  }
  return { slot: 'other', scale: 1 };
}

/** Slot a file belongs to, for `image` binding targets. */
export function slotOf(name: string): string | null {
  const c = classifyAsset(name);
  return c && c.slot !== 'strings' && c.slot !== 'other' ? c.slot : null;
}

export interface TemplatePackage {
  manifest: TemplateManifest;
  passJson: PassJson;
  assets: AssetEntry[];
  /** name -> bytes, for assets only. */
  bytes: Record<string, Uint8Array>;
}

function parseJson<T>(files: Record<string, Uint8Array>, name: string): T {
  const file = files[name];
  if (!file) throw new Error(`Template package is missing ${name}.`);
  try {
    return JSON.parse(decoder.decode(file)) as T;
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}

/** Reads a package given as name -> bytes (an unzipped .pkpasstemplate plus wallet.template.json). */
export async function readTemplatePackage(
  input: Record<string, Uint8Array>,
  options: { strips?: boolean } = {},
): Promise<TemplatePackage> {
  let files = input;
  const manifest = parseJson<TemplateManifest>(files, 'wallet.template.json');
  const passJson = parseJson<PassJson>(files, 'pass.json');
  const assets: AssetEntry[] = [];
  const bytes: Record<string, Uint8Array> = {};
  // `strips: false` is for callers that read only the manifest: drawing every strip is the cost.
  const strip = stripBlock(manifest);
  if (strip && options.strips !== false) {
    const drawn = renderStampFiles(strip, files);
    const first = drawn.issues.find((i) => i.severity === 'error');
    if (first) throw new Error(`${first.code}: ${first.message}`);
    files = { ...files };
    for (const strip of drawn.strips) files[strip.name] = strip.bytes;
  }
  for (const name of Object.keys(files).sort()) {
    const classified = classifyAsset(name);
    const data = files[name];
    if (!classified || !data) continue;
    const size =
      classified.slot === 'strings' || classified.slot === 'other' ? null : pngSize(data);
    bytes[name] = data;
    assets.push({
      name,
      ...classified,
      size: data.length,
      sha1: await sha1Hex(data),
      crc32: crc32(data),
      ...(size ?? {}),
      source: { kind: 'inline' },
    });
  }
  return { manifest, passJson, assets, bytes };
}
