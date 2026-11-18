import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../../../passkit/types.ts';
import { generatedSource } from '../sync.ts';
import { buildKey } from './hash.ts';

const WALLETS: TemplateManifest['wallets'] = {
  schema: 1,
  roles: { points: false },
  google: { type: 'generic', images: { logo: 'wallets/google/logo.png' } },
};
const art = {
  name: 'wallets/google/logo.png',
  slot: 'source' as const,
  scale: 1 as const,
  size: 1,
  sha1: 'f'.repeat(40),
  crc32: 1,
};

const keys = async () =>
  Object.fromEntries(
    await Promise.all(generatedSource.templates.map(async (t) => [t.slug, await buildKey(t)])),
  );

describe('build keys of the baked templates', () => {
  it('are unchanged by the wallets extension (snapshot taken before it existed)', async () => {
    expect(await keys()).toMatchSnapshot();
  });

  it.each(generatedSource.templates.map((t) => [t.slug, t] as const))(
    '%s: the same key with a wallets block and wallets art',
    async (_slug, t) => {
      const extended = {
        ...t,
        manifest: { ...t.manifest, wallets: WALLETS },
        assets: [...t.assets, art],
      };
      expect(await buildKey(extended)).toBe(await buildKey(t));
    },
  );
});
