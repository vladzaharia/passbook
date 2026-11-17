import { stampKey } from '../../../../passkit/stamps/key.ts';
import { renderStampFiles, type StampFiles } from '../../../../passkit/stamps/package.ts';
import type { AssetEntry, TemplateManifest, ValidationIssue } from '../../../../passkit/types.ts';
import { crc32, sha1Hex, sha256BytesHex } from './hash.ts';
import type { CheckedImage } from './images.ts';
import { byteLru } from './stamps-cache.ts';

type Analyzed = Omit<AssetEntry, 'source'>;

export interface StampOutput {
  files: Map<string, Uint8Array>;
  assets: Analyzed[];
  issues: ValidationIssue[];
}

export interface StampOptions {
  /** Counts to draw (a dry run's sample). Default every count 0 to goal. */
  counts?: readonly number[];
  /** Counts the build check reads: the only ones drawn when the rest is carried. */
  sample?: readonly number[];
  /** Strips an earlier version drew from the same key, or null. A hit lists them undrawn. */
  carry?: (key: string) => Promise<Analyzed[] | null>;
}

/** `stamps/strips/` in an upload: the server draws those files. */
export const stampsReserved = (path: string): ValidationIssue => ({
  severity: 'error',
  code: 'STAMPS_RESERVED',
  message: 'stamps/strips/ is generated. Remove these files.',
  path,
});

function pngDims(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const meta = async (name: string, bytes: Uint8Array) => ({
  name,
  size: bytes.length,
  sha1: await sha1Hex(bytes),
  crc32: crc32(bytes),
  ...(pngDims(bytes) ?? {}),
});

// The designer's live check draws the sample on every pause; the same key and count draw the same
// bytes, so an isolate keeps recent ones. Bounded by bytes (strips are PNGs of tens of KB to MB),
// not by count: tenants' art must not add up past a few MB of a 128 MB isolate.
const DRAWN_MAX_BYTES = 8 * 1024 * 1024;
const drawn = byteLru<StampFiles>(DRAWN_MAX_BYTES, (f) =>
  f.strips.reduce((n, s) => n + s.bytes.length, 0),
);

function remember(id: string, files: StampFiles): void {
  if (files.strips.length > 0) drawn.set(id, files);
}

/**
 * The stamp art as source assets and, with a stamps block, every generated strip pair: carried
 * from an earlier version with the same key, else drawn.
 */
export async function stampOutput(
  manifest: TemplateManifest | undefined,
  art: ReadonlyMap<string, Uint8Array>,
  strips: readonly CheckedImage[],
  options: StampOptions = {},
): Promise<StampOutput> {
  const out: StampOutput = { files: new Map(), assets: [], issues: [] };
  const digest = new Map<string, string>();
  for (const [name, bytes] of art) {
    const m = await meta(name, bytes);
    digest.set(name, await sha256BytesHex(bytes));
    out.files.set(name, bytes);
    out.assets.push({ ...m, slot: 'source', scale: 1 });
  }
  const block = manifest?.stamps;
  if (!block) return out;
  const inputs = new Map(art);
  for (const s of strips)
    if (!s.locale && (s.scale === 2 || s.scale === 3)) {
      const name = `strip@${s.scale}x.png`;
      inputs.set(name, s.bytes);
      digest.set(name, await sha256BytesHex(s.bytes));
    }
  const key = await stampKey(block, (name) => digest.get(name));
  const carried = options.carry ? await options.carry(key) : null;
  const counts = carried ? (options.sample ?? options.counts ?? []) : options.counts;
  const id = counts ? `${key}|${counts.join(',')}` : null;
  const cached = id ? drawn.get(id) : undefined;
  const result = cached ?? renderStampFiles(block, inputs, counts ? { counts } : {});
  if (id && !cached) remember(id, result);
  out.issues.push(...result.issues);
  if (carried) out.assets.push(...carried);
  for (const strip of result.strips) {
    out.files.set(strip.name, strip.bytes);
    if (carried) continue;
    out.assets.push({
      ...(await meta(strip.name, strip.bytes)),
      slot: 'strip',
      scale: strip.scale,
      stamps: strip.count,
      width: strip.width,
      height: strip.height,
    });
  }
  return out;
}
