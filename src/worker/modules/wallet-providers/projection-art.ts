import type { ShippedAsset } from '../../../passkit/build-assets.ts';
import { classifyAsset } from '../../../passkit/template/package.ts';
import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import type { WalletTarget } from '../../../passkit/template/wallets/art-rules.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type ArtRequest,
  artTransformFromBinding,
  deriveWalletArt,
  sizeWalletArt,
} from './assets.ts';

/** The provider slot an Apple art slot is cut for (the one its compiler picks it for first). */
const APPLE_ART_SLOT: Record<WalletTarget, Record<string, string>> = {
  google: {
    icon: 'logo',
    logo: 'logo',
    primaryLogo: 'logo',
    strip: 'hero',
    background: 'hero',
    artwork: 'hero',
  },
  samsung: {
    icon: 'logo',
    logo: 'logo',
    primaryLogo: 'logo',
    strip: 'background',
    background: 'background',
    artwork: 'background',
  },
};

/** A stand-in address with the shape of a real one: only a publication derives the real hash. */
const DRY_PATH = `/w/i/${'0'.repeat(64)}.png`;

export interface WalletArt {
  /** Public address by template file name. A file with no derived copy has none. */
  urls: Map<string, string>;
  /** The size of the derived copy, so compilers judge what a provider will actually show. */
  sizes: Map<string, { width: number; height: number }>;
  /** Hashes of the copies a `store` run wrote; empty for a dry run. */
  hashes: Set<string>;
}

/** A file a pass build generated (stamp strip, per-pass override) is not template art, whatever its name. */
const isGenerated = (asset: Pick<ShippedAsset, 'source' | 'bytes'>): boolean =>
  asset.source !== undefined || asset.bytes !== undefined;

/** Every template file a compiler may pick for `target`, with the provider slot it is cut for. */
export function artRequests(
  template: Pick<ResolvedTemplate, 'manifest'>,
  target: WalletTarget,
  shipped: readonly ShippedAsset[],
): ArtRequest[] {
  const images: Record<string, string> = template.manifest.wallets?.[target]?.images ?? {};
  return [
    ...Object.entries(images).map(([slot, asset]) => ({ target, slot, asset })),
    ...shipped.flatMap((asset) => {
      const slot = APPLE_ART_SLOT[target][classifyAsset(asset.name)?.slot ?? ''];
      return slot && !isGenerated(asset) ? [{ target, slot, asset: asset.name }] : [];
    }),
  ];
}

/** Derived sizes replace a template file's own; a generated file keeps the size the build gave it. */
export function sizeShipped(shipped: readonly ShippedAsset[], art: WalletArt): ShippedAsset[] {
  return shipped.map((asset) => {
    const size = isGenerated(asset) ? undefined : art.sizes.get(asset.name);
    return size ? { ...asset, ...size } : asset;
  });
}

/**
 * Prepares the art a compiler may pick for `target`: the author's `wallets.<target>.images` files,
 * then the Apple art by slot. A file below its minimum, or in a slot without a rule, gets no
 * address and the compiler reports it. `dry` only sizes (reads, review, offer checks); `store`
 * cuts and writes the public copies and is for release publication alone.
 */
export async function prepareProjectionArt(
  ctx: ServiceContext,
  registry: TemplateRegistry,
  template: ResolvedTemplate,
  target: WalletTarget,
  shipped: readonly ShippedAsset[],
  mode: 'dry' | 'store',
): Promise<WalletArt> {
  const origin = baseUrl(ctx.env);
  const transform = artTransformFromBinding(ctx.env.IMAGES);
  const art: WalletArt = { urls: new Map(), sizes: new Map(), hashes: new Set() };
  for (const request of artRequests(template, target, shipped)) {
    if (art.urls.has(request.asset)) continue;
    if (mode === 'dry') {
      const size = await sizeWalletArt(registry, template, request);
      if (!size) continue;
      art.urls.set(request.asset, `${origin}${DRY_PATH}`);
      art.sizes.set(request.asset, size);
      continue;
    }
    const derived = await deriveWalletArt(ctx.env, registry, template, request, transform);
    if (!derived) continue;
    art.urls.set(request.asset, `${origin}${derived.path}`);
    art.sizes.set(request.asset, { width: derived.width, height: derived.height });
    art.hashes.add(derived.sha256);
  }
  return art;
}
