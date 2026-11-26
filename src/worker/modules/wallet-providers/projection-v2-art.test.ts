import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { crc32 } from '../templates/package/hash.ts';
import { getVersion } from '../templates/repo.ts';
import { sizeWalletArt } from './assets.ts';
import { computeProjectionPins } from './projection-pins.ts';
import { installV2Env, S, setup } from './projection-v2-test-fixtures.ts';

installV2Env();

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
/** A PNG that does not compress: its size is about width x height x 4 bytes. */
function noisyPng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width * 4; x++)
      rows[y * (1 + width * 4) + 1 + x] = (x * 7919 + y * 104729 + ((x * y) % 251)) & 255;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(rows, { level: 0 })),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const stub = (name: string, bytes: Uint8Array) => {
  const template = {
    assets: [{ name, slot: 'source', scale: 1 }],
  } as unknown as ResolvedTemplate;
  const registry = {
    openAsset: async () => new Response(bytes as BufferSource).body,
  } as unknown as TemplateRegistry;
  return { template, registry };
};

describe('review sizes art the way publication does', () => {
  it('refuses an uncut copy that is over the target byte cap, and accepts one under it', async () => {
    const asset = 'wallets/samsung/logo.png';
    const over = stub(asset, noisyPng(256, 256));
    // 256x256 stored without compression is 256 KB plus headers: over the logo cap.
    expect(
      await sizeWalletArt(over.registry, over.template, { target: 'samsung', slot: 'logo', asset }),
    ).toBeNull();
    const small = stub(asset, makePng(64, 64));
    expect(
      await sizeWalletArt(small.registry, small.template, {
        target: 'samsung',
        slot: 'logo',
        asset,
      }),
    ).toEqual({
      width: 64,
      height: 64,
    });
  });

  it('asks Images for the width alone when it downscales, so a resizer that keeps the aspect meets the plan', async () => {
    const hero = 'wallets/google/hero.png';
    // 1125 x 432 into 1032 wide is 396.29 high: a 1032 x 396 box would come back 1031 wide.
    const kit = await setup(
      { [hero]: makePng(1125, 432) },
      { schema: 1, google: { images: { hero } } },
    );
    const version = await getVersion(S.env.DB, kit.templateId, kit.version);
    if (!version) throw new Error('Version missing.');
    const asked: unknown[] = [];
    const result = makePng(1032, 396);
    const images = {
      input: () => ({
        transform: (size: unknown) => {
          asked.push(size);
          return {
            output: async () => ({ image: () => new Response(result as BufferSource).body }),
          };
        },
      }),
    };
    const ctx = createServiceContext(
      { ...S.env, IMAGES: images as unknown as ImagesBinding },
      { clock: S.clock },
    );
    const stored = await computeProjectionPins(ctx, 'google', version, 'store');
    expect(asked).toEqual([{ width: 1032, fit: 'scale-down' }]);
    expect(stored.art.sizes.get(hero)).toEqual({ width: 1032, height: 396 });
  });

  it('fails publication with a coded error when the cut is not the size review assumed', async () => {
    const hero = 'wallets/google/hero.png';
    const kit = await setup(
      { [hero]: makePng(2064, 100) },
      { schema: 1, google: { images: { hero } } },
    );
    const version = await getVersion(S.env.DB, kit.templateId, kit.version);
    if (!version) throw new Error('Version missing.');
    // Review: a dry run sizes the cut to 1032 x 50.
    const dry = await computeProjectionPins(kit.ctx, 'google', version);
    expect(dry.art.sizes.get(hero)).toEqual({ width: 1032, height: 50 });
    // Publication: an Images binding that returns another size is a visible mismatch.
    const wrong = makePng(1032, 49);
    const images = {
      input: () => ({
        transform: () => ({
          output: async () => ({ image: () => new Response(wrong as BufferSource).body }),
        }),
      }),
    };
    const ctx = createServiceContext(
      { ...S.env, IMAGES: images as unknown as ImagesBinding },
      {
        clock: S.clock,
      },
    );
    await expect(computeProjectionPins(ctx, 'google', version, 'store')).rejects.toMatchObject({
      code: 'WALLET_ART_MISMATCH',
    });
    // A binding that returns the planned size stores it.
    const right = makePng(1032, 50);
    const good = {
      input: () => ({
        transform: () => ({
          output: async () => ({ image: () => new Response(right as BufferSource).body }),
        }),
      }),
    };
    const ok = createServiceContext(
      { ...S.env, IMAGES: good as unknown as ImagesBinding },
      { clock: S.clock },
    );
    expect((await computeProjectionPins(ok, 'google', version, 'store')).art.hashes.size).toBe(1);
  });
});
