/** Test helpers: wallet views of the baked and starter templates, with and without Google art. */
import { loadBaked } from '../../template/baked-fixtures.ts';
import type { AssetEntry } from '../../types.ts';
import type { WalletPassView } from '../types.ts';
import { viewOf } from '../view-fixtures.ts';

const png = (name: string, width: number, height: number): AssetEntry =>
  ({ name, slot: 'other', scale: 1, size: 1, sha1: '', crc32: 0, width, height }) as AssetEntry;

export const GOOGLE_ART = [
  png('wallets/google/logo.png', 1024, 1024),
  png('wallets/google/hero.png', 1032, 812),
  png('wallets/google/thumb.png', 1860, 1860),
];
export const ART_BLOCK = {
  schema: 1,
  google: {
    images: {
      logo: 'wallets/google/logo.png',
      hero: 'wallets/google/hero.png',
    },
  },
};

export const assetUrl = (name: string): string =>
  `https://img.example/w/i/${name.replace(/[^A-Za-z0-9]+/gu, '-')}`;

export interface GoogleViewOptions {
  /** `wallets` block merged over the art block (art on) or alone (art off). */
  wallets?: Record<string, unknown>;
  art?: boolean;
  /** Override pieces of the view after it is built. */
  patch?: (view: WalletPassView) => void;
}

export async function googleView(
  slug: string,
  options: GoogleViewOptions = {},
): Promise<WalletPassView> {
  const { template } = await loadBaked(slug);
  const art = options.art !== false;
  const wallets = {
    ...(art ? ART_BLOCK : { schema: 1 }),
    ...options.wallets,
    google: {
      ...(art ? ART_BLOCK.google : {}),
      ...((options.wallets?.google as object | undefined) ?? {}),
    },
  };
  const view = await viewOf(slug, {
    wallets,
    ctx: { assets: [...template.assets, ...(art ? GOOGLE_ART : [])], assetUrl },
  });
  options.patch?.(view);
  return view;
}
