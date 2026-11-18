/** Test helper: the Samsung compile of a baked template's sample, with public image URLs. */

import type { CompileResult, WalletPassView } from '../types.ts';
import { NOW, viewOf } from '../view-fixtures.ts';
import type { SamsungCompileOptions } from './context.ts';
import { samsungCompiler } from './index.ts';

export { NOW };
export const APP = {
  name: 'Example Org',
  url: 'https://org.example',
  logo: 'https://img.example/org-logo.png',
};

export const imageUrl = (name: string): string => `https://img.example/${name}`;

export const view = (
  slug: string,
  options: { wallets?: unknown; appLink?: typeof APP | null } = {},
): Promise<WalletPassView> =>
  viewOf(slug, {
    ...(options.wallets === undefined ? {} : { wallets: options.wallets }),
    ctx: {
      assetUrl: imageUrl,
      ...(options.appLink === null ? {} : { appLink: options.appLink ?? APP }),
    },
  });

export const compile = (
  v: WalletPassView,
  options: Partial<SamsungCompileOptions> = {},
): CompileResult =>
  samsungCompiler.compile(v, { now: NOW, omit: [], ...options } as SamsungCompileOptions);

/** The card attributes of a result, or throws when the pass was blocked. */
export function attributes(result: CompileResult): Record<string, string> {
  const data = result.cardData as { attributes: Record<string, string> } | undefined;
  if (!data) throw new Error(`blocked: ${result.blocked?.message}`);
  return data.attributes;
}
