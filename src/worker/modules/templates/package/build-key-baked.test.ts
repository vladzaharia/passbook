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

const templates = generatedSource.templates.map((t) => [t.slug, t] as const);

describe('build keys of the baked templates', () => {
  // A new key moves every pass of the template to a new version, so a change here is deliberate.
  // Refreshed once the paper block joined the key; wallets and channels never do.
  it('are pinned (snapshot)', async () => {
    // The hashes alone, in slug order: named lines read as secrets to scanners.
    expect(Object.values(await keys())).toMatchSnapshot();
  });

  it.each(templates)(
    '%s: the same key with a wallets block, wallets art and channels',
    async (_s, t) => {
      const extended = {
        ...t,
        manifest: { ...t.manifest, wallets: WALLETS, channels: { paper: 'off' as const } },
        assets: [...t.assets, art],
      };
      expect(await buildKey(extended)).toBe(await buildKey(t));
    },
  );

  it.each(templates)('%s: the scanner display is not part of the key', async (_s, t) => {
    if (!t.manifest.scan) return;
    const { display: _display, ...scan } = t.manifest.scan;
    expect(await buildKey({ ...t, manifest: { ...t.manifest, scan } })).toBe(await buildKey(t));
  });

  it('counts the paper block: another block is another key', async () => {
    const t = generatedSource.templates.find((x) => x.manifest.paper);
    if (!t?.manifest.paper) throw new Error('No baked template has a paper block.');
    const other = {
      ...t,
      manifest: { ...t.manifest, paper: { ...t.manifest.paper, ink: 'mono' as const } },
    };
    expect(await buildKey(other)).not.toBe(await buildKey(t));
  });

  it("Henry's access row is on the scanner panel only, so the Apple pass is untouched", () => {
    for (const slug of ['henrys-blue', 'henrys-copper']) {
      const t = generatedSource.templates.find((x) => x.slug === slug);
      if (!t) throw new Error(`No baked template ${slug}.`);
      expect(JSON.stringify(t.manifest.scan?.display)).toContain('r_access');
      expect(JSON.stringify(t.passJson)).not.toContain('r_access');
    }
  });
});
