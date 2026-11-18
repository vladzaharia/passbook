import { describe, expect, it } from 'vitest';
import type { AssetEntry, PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { canonicalJson, crc32, sha1Hex } from './package/hash.ts';
import {
  appleCandidateContent,
  type ReleaseVersionContent,
  templateContentDigest,
} from './release-content.ts';

const encoder = new TextEncoder();
const files: Record<string, Uint8Array> = {
  'icon.png': encoder.encode('icon bytes'),
  'wallets/google/logo.png': encoder.encode('logo bytes'),
};
const ctx = {
  env: {
    BUCKET: {
      get: async (key: string) => {
        const bytes = files[key];
        return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
      },
    },
  },
} as unknown as ServiceContext;

async function asset(name: string, slot: AssetEntry['slot']): Promise<AssetEntry> {
  const bytes = files[name] as Uint8Array;
  return {
    name,
    slot,
    scale: 1,
    size: bytes.length,
    sha1: await sha1Hex(bytes),
    crc32: crc32(bytes),
    source: { kind: 'r2', key: name },
  };
}

const manifest = {
  schema: 1,
  name: 'Card',
  inputs: { type: 'object' },
  sample: {},
  bindings: [],
  display: { title: 'Card' },
} as unknown as TemplateManifest;
const passJson = { formatVersion: 1, generic: {} } as unknown as PassJson;
const wallets: TemplateManifest['wallets'] = { schema: 1, google: { type: 'off' } };

async function version(withWallets: boolean): Promise<ReleaseVersionContent> {
  const icon = await asset('icon.png', 'icon');
  return {
    manifest: withWallets ? { ...manifest, wallets } : manifest,
    passJson,
    assets: withWallets ? [icon, await asset('wallets/google/logo.png', 'source')] : [icon],
  };
}

describe('Apple release content digest', () => {
  it('is the same for a version that differs only in wallets', async () => {
    const plain = await templateContentDigest(ctx, await version(false));
    const extended = await templateContentDigest(ctx, await version(true));
    expect(extended.hash).toBe(plain.hash);
  });

  it('is unchanged for a version without wallets', async () => {
    const v = await version(false);
    const assets = await Promise.all(
      v.assets.map(async ({ source: _s, ...a }) => ({
        ...a,
        sha256: await sha256Hex(files[a.name] as Uint8Array),
      })),
    );
    const expected = await sha256Hex(
      canonicalJson({ manifest: v.manifest, passJson: v.passJson, assets }),
    );
    expect((await templateContentDigest(ctx, v)).hash).toBe(expected);
  });

  it('still reads and digests every asset, wallets art included', async () => {
    const v = await version(true);
    const { hash, assetHashes } = await templateContentDigest(ctx, v);
    expect(assetHashes.map((a) => a.name)).toEqual(['icon.png', 'wallets/google/logo.png']);
    // The issuance check re-derives the hash from the stored digests, without reading bytes.
    expect((await templateContentDigest(ctx, v, [], assetHashes)).hash).toBe(hash);
    files['wallets/google/logo.png'] = encoder.encode('changed bytes!');
    await expect(templateContentDigest(ctx, v)).rejects.toThrow(/hash mismatch/);
    files['wallets/google/logo.png'] = encoder.encode('logo bytes');
  });

  it('changes when anything Apple reads changes', async () => {
    const plain = await templateContentDigest(ctx, await version(false));
    const renamed = await version(true);
    const other = await templateContentDigest(ctx, {
      ...renamed,
      manifest: { ...renamed.manifest, name: 'Other' },
    });
    expect(other.hash).not.toBe(plain.hash);
  });

  it('drops only the wallets key and the wallets/ files', async () => {
    const v = await version(true);
    const { manifest: m, assets } = appleCandidateContent(v.manifest, v.assets);
    expect(m).toEqual(manifest);
    expect(assets.map((a) => a.name)).toEqual(['icon.png']);
    expect(appleCandidateContent(manifest, []).manifest).toBe(manifest);
  });
});
