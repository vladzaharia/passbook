import { classifyAsset } from '../../../passkit/template/package.ts';
import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import type { WalletTarget } from '../../../passkit/template/wallets/art-rules.ts';
import type { WalletsManifest } from '../../../passkit/template/wallets/schema.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { artTransformFromBinding, deriveWalletArt } from './assets.ts';

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

export interface WalletArt {
  /** Public address by template file name. A file with no derived copy has none. */
  urls: Map<string, string>;
  /** The size of the derived copy, so compilers judge what a provider will actually show. */
  sizes: Map<string, { width: number; height: number }>;
}

/**
 * Derives the public copy of every template file a compiler may pick for `target`: the author's
 * `wallets.<target>.images` files, then the Apple art by slot. A file below its minimum, or in a
 * slot without a rule, gets no address and the compiler reports it.
 */
export async function deriveProjectionArt(
  ctx: ServiceContext,
  registry: TemplateRegistry,
  template: ResolvedTemplate,
  target: WalletTarget,
  shipped: readonly string[],
): Promise<WalletArt> {
  const wallets: WalletsManifest | undefined = template.manifest.wallets;
  const images: Record<string, string> = wallets?.[target]?.images ?? {};
  const requests = [
    ...Object.entries(images).map(([slot, asset]) => ({ slot, asset })),
    ...shipped.flatMap((asset) => {
      const slot = APPLE_ART_SLOT[target][classifyAsset(asset)?.slot ?? ''];
      return slot ? [{ slot, asset }] : [];
    }),
  ];
  const origin = baseUrl(ctx.env);
  const transform = artTransformFromBinding(ctx.env.IMAGES);
  const art: WalletArt = { urls: new Map(), sizes: new Map() };
  for (const { slot, asset } of requests) {
    if (art.urls.has(asset)) continue;
    const derived = await deriveWalletArt(
      ctx.env,
      registry,
      template,
      { target, slot, asset },
      transform,
    );
    if (!derived) continue;
    art.urls.set(asset, `${origin}${derived.path}`);
    art.sizes.set(asset, { width: derived.width, height: derived.height });
  }
  return art;
}
