import { beforeEach, describe, expect, it } from 'vitest';
import { ASSET_CACHE_MAX_BYTES, cachedAssetBytes, clearAssetCache } from './asset-cache.ts';
import { buildPass } from './build.ts';
import { bakedBehaviors, freezeNow, loadBaked } from './template/baked-fixtures.ts';
import { FIXTURE_IDENTITY, createFixtureIdentity } from './testing/fixture-identity.ts';

beforeEach(() => clearAssetCache());

describe('cachedAssetBytes', () => {
  it('loads once per template version, name and digest', async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      return new Uint8Array(4);
    };
    const entry = { name: 'icon.png', sha1: 'aa' };
    await cachedAssetBytes('t', 'v1', entry, load);
    await cachedAssetBytes('t', 'v1', entry, load);
    expect(loads).toBe(1);
    await cachedAssetBytes('t', 'v2', entry, load);
    await cachedAssetBytes('t', 'v1', { name: 'icon.png', sha1: 'bb' }, load);
    expect(loads).toBe(3);
  });

  it('never caches entries without a digest', async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      return new Uint8Array(1);
    };
    await cachedAssetBytes('t', 'v1', { name: 'a.png', sha1: '' }, load);
    await cachedAssetBytes('t', 'v1', { name: 'a.png', sha1: '' }, load);
    expect(loads).toBe(2);
  });

  it('evicts the least recently used entries over budget', async () => {
    let loads = 0;
    const big = async () => {
      loads++;
      return new Uint8Array(Math.floor(ASSET_CACHE_MAX_BYTES / 2) + 1);
    };
    await cachedAssetBytes('t', 'v', { name: 'a', sha1: '1' }, big);
    await cachedAssetBytes('t', 'v', { name: 'b', sha1: '2' }, big);
    await cachedAssetBytes('t', 'v', { name: 'a', sha1: '1' }, big);
    expect(loads).toBe(3);
  });
});

describe('buildPass', () => {
  it('reads each template asset once across many passes', async () => {
    freezeNow();
    const material = await createFixtureIdentity();
    const { template, registry } = await loadBaked('starter-coupon');
    let opens = 0;
    const counting = {
      ...registry,
      async openAsset(t: typeof template, name: string) {
        opens++;
        return registry.openAsset(t, name);
      },
    };
    const run = () =>
      buildPass({
        template,
        registry: counting,
        input: template.manifest.sample,
        server: {
          serial: 's',
          authToken: 'a'.repeat(32),
          webServiceURL: 'https://wallet.example/wallet',
          organizationName: 'Wallet',
          identity: FIXTURE_IDENTITY,
        },
        signing: material,
        behaviors: bakedBehaviors,
      });
    await run();
    const first = opens;
    expect(first).toBeGreaterThan(0);
    await run();
    await run();
    expect(opens).toBe(first);
  });
});
