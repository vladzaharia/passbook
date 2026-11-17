import type { AssetOverride, PassBuildError } from './build.ts';
import { stampStripName } from './stamps/strips.ts';
import { applyDefaults } from './template/manifest.ts';
import { classifyAsset, pngSize, STAMP_STRIP, slotOf } from './template/package.ts';
import type { ResolvedTemplate } from './template/registry.ts';
import { stampScopeFor } from './template/stamps.ts';
import type { Personalization } from './types.ts';

export interface ShippedAsset {
  name: string;
  /** The stored file, when it differs from `name` (a generated strip shipped as `strip@2x.png`). */
  source?: string;
  width?: number;
  height?: number;
  size?: number;
  sha1?: string;
  crc32?: number;
  bytes?: Uint8Array;
}

/** A problem found while choosing files. `build.ts` turns it into a PassBuildError. */
export class AssetPlanError extends Error {
  readonly code: PassBuildError['code'];
  readonly path: string | undefined;
  constructor(code: PassBuildError['code'], message: string, path?: string) {
    super(message);
    this.name = 'AssetPlanError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Template files minus preview-only, stamp art and dropped slots, with per-pass overrides
 * applied. With a stamps block, the generated strip for `stampCount` ships as `strip@Nx.png`.
 */
export function shippedAssets(
  template: ResolvedTemplate,
  dropped: string[],
  overrides: Record<string, AssetOverride>,
  stampCount?: number,
): ShippedAsset[] {
  const previewOnly = new Set(template.manifest.previewOnlyAssets ?? []);
  const isDropped = (name: string) => {
    const slot = slotOf(name);
    return slot !== null && dropped.includes(slot);
  };
  const stamped = stampCount !== undefined && template.manifest.stamps !== undefined;
  const out = new Map<string, ShippedAsset>();
  for (const entry of template.assets) {
    const strip = STAMP_STRIP.exec(entry.name);
    const count = entry.stamps ?? (strip ? Number(strip[1]) : undefined);
    const scale = strip ? Number(strip[2]) : entry.scale;
    const generated = count !== undefined;
    const art = entry.slot === 'source' || (entry.name.startsWith('stamps/') && !generated);
    if (previewOnly.has(entry.name) || art) continue;
    if (generated && !stamped) continue;
    if (stamped && !generated && !entry.override && /^strip(?:@[23]x)?\.png$/.test(entry.name))
      continue;
    if (!generated && isDropped(entry.name)) continue;
    let name = entry.name;
    if (generated) {
      if (count !== stampCount) continue;
      name = `strip@${scale}x.png`;
    }
    out.set(name, {
      name,
      ...(generated ? { source: entry.name } : {}),
      ...(entry.size ? { size: entry.size } : {}),
      ...(entry.width ? { width: entry.width } : {}),
      ...(entry.height ? { height: entry.height } : {}),
      ...(entry.sha1 ? { sha1: entry.sha1 } : {}),
      ...(entry.crc32 !== undefined ? { crc32: entry.crc32 } : {}),
    });
  }
  if (stamped && !out.has('strip@2x.png') && !out.has('strip@3x.png'))
    throw new AssetPlanError('TEMPLATE', `No strip for ${stampCount} stamps.`, 'stamps');
  for (const [name, override] of Object.entries(overrides)) {
    const kind = classifyAsset(name);
    if (!kind || kind.slot === 'other' || kind.slot === 'strings' || kind.slot === 'source')
      throw new AssetPlanError(
        'INVALID_INPUT',
        `${name} is not an image slot file.`,
        `assetOverrides/${name}`,
      );
    if (isDropped(name)) continue;
    const size = pngSize(override.bytes);
    if (!size)
      throw new AssetPlanError('INVALID_INPUT', `${name} is not a PNG.`, `assetOverrides/${name}`);
    out.set(name, {
      name,
      ...size,
      size: override.bytes.length,
      bytes: override.bytes,
      ...(override.sha1 ? { sha1: override.sha1 } : {}),
    });
  }
  // Every device Wallet runs on is @2x or @3x: a @1x file is dead weight once a larger one ships.
  const hasRetina = (name: string) =>
    [2, 3].some((scale) => out.has(name.replace(/\.png$/, `@${scale}x.png`)));
  for (const name of [...out.keys()])
    if (/^(?:[^/]+\.lproj\/)?[A-Za-z]+\.png$/.test(name) && hasRetina(name)) out.delete(name);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The images a viewer of one pass loads, by the name Wallet sees (`strip@2x.png`), each with the
 * stored file behind it. Null when the template has no stamps block: its assets are served as is.
 */
export function stampedView(
  template: ResolvedTemplate,
  personalization: Personalization,
): ShippedAsset[] | null {
  const count = stampCountOf(template, personalization);
  if (count === undefined) return null;
  try {
    return shippedAssets(template, [], {}, count);
  } catch (error) {
    if (error instanceof AssetPlanError) return null;
    throw error;
  }
}

/** Stamps on the card an input describes (0 to goal), or undefined without a stamps block. */
export function stampCountOf(
  template: ResolvedTemplate,
  personalization: Personalization,
): number | undefined {
  if (!template.manifest.stamps) return undefined;
  return stampScopeFor(template.manifest, applyDefaults(template.manifest, personalization))?.card;
}

/** The stored file a stamp card shows as `name` at `count` stamps: the strip drawn for that count. */
export function stampedName(
  template: ResolvedTemplate,
  name: string,
  count: number | undefined,
): string {
  const goal = template.manifest.stamps?.goal;
  const scale = /^strip@([23])x\.png$/.exec(name)?.[1];
  if (count === undefined || goal === undefined || !scale) return name;
  return stampStripName(Math.max(0, Math.min(count, goal)), scale === '3' ? 3 : 2);
}
