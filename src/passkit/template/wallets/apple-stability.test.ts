import { beforeAll, describe, expect, it } from 'vitest';
import { buildPass } from '../../build.ts';
import { createFixtureIdentity, FIXTURE_IDENTITY } from '../../testing/fixture-identity.ts';
import type { AssetEntry, SigningMaterial } from '../../types.ts';
import { bakedBehaviors, bakedSlugs, freezeNow, loadBaked } from '../baked-fixtures.ts';
import { classifyAsset } from '../package.ts';
import type { ResolvedTemplate } from '../registry.ts';
import type { WalletsManifest } from './schema.ts';

const ART = 'wallets/google/logo.png';
const ART_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const WALLETS: WalletsManifest = {
  schema: 1,
  roles: { points: false, eventId: { value: { const: 'evt-1' } } },
  required: ['type'],
  google: { type: 'generic', images: { logo: ART } },
  samsung: { type: 'off' },
};

let signing: SigningMaterial;
let now: Date;
beforeAll(async () => {
  signing = await createFixtureIdentity();
  now = freezeNow();
}, 120_000);

/** The template as the analyzer stores it with a wallets block: the block and its art, as `source`. */
function withWallets(template: ResolvedTemplate): ResolvedTemplate {
  const art: AssetEntry = {
    name: ART,
    slot: 'source',
    scale: 1,
    size: ART_BYTES.length,
    sha1: '0'.repeat(40),
    crc32: 0,
    source: { kind: 'inline' },
  };
  return {
    ...template,
    manifest: { ...template.manifest, wallets: WALLETS },
    assets: [...template.assets, art],
  };
}

async function build(slug: string, wallets: boolean, previousHash?: string) {
  const { template, registry } = await loadBaked(slug);
  const used = wallets ? withWallets(template) : template;
  return buildPass({
    template: used,
    registry: {
      ...registry,
      async resolve() {
        return used;
      },
      async openAsset(t, name) {
        if (name !== ART) return registry.openAsset(t, name);
        return new Response(ART_BYTES as BodyInit).body as ReadableStream<Uint8Array>;
      },
    },
    input: template.manifest.sample,
    server: {
      serial: 'SNAPSHOT-SERIAL',
      authToken: 'a'.repeat(32),
      webServiceURL: 'https://wallet.example/wallet',
      organizationName: template.manifest.org?.name ?? 'PassBook',
      identity: FIXTURE_IDENTITY,
    },
    signing,
    behaviors: bakedBehaviors,
    now,
    ...(previousHash ? { previousHash } : {}),
  });
}

// Builds every baked pass twice; PNG composition under v8 coverage runs about 10x slower than locally.
describe('Apple output ignores the wallets block', () => {
  it('has templates to check', () => {
    expect(bakedSlugs().length).toBeGreaterThan(5);
  });

  it('never classifies wallets art as a pass file', () => {
    expect(classifyAsset(ART)).toBeNull();
    expect(classifyAsset('wallets/samsung/main.png')).toBeNull();
  });

  it.each(bakedSlugs())(
    '%s: same contentHash, files and pass.json with and without wallets',
    async (slug) => {
      const plain = await build(slug, false);
      const extended = await build(slug, true);
      expect(extended.contentHash).toBe(plain.contentHash);
      expect(extended.passJson).toEqual(plain.passJson);
      expect(extended.report.issues).toEqual(plain.report.issues);
      // Nothing is signed for a wallets-only change: the stale-reissue path sees an unchanged hash.
      const again = await build(slug, true, plain.contentHash);
      expect(again.changed).toBe(false);
      expect(Object.keys(extended.signed?.files ?? {}).sort()).toEqual(
        Object.keys(plain.signed?.files ?? {}).sort(),
      );
    },
    180_000,
  );
});
