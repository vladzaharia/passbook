import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../platform/env.ts';
import { ConflictError } from '../../platform/errors.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { putVersionAsset } from './asset-storage.ts';

let ctx: ServiceContext;
let key: string;

beforeEach(() => {
  ctx = createServiceContext(env as AppEnv);
  key = `templates/asset-storage-test/${crypto.randomUUID()}/v1/icon.png`;
});

afterEach(async () => {
  await ctx.env.BUCKET.delete(key);
});

async function storedObject(): Promise<R2ObjectBody> {
  const object = await ctx.env.BUCKET.get(key);
  if (!object) throw new Error('Missing stored asset');
  return object;
}

describe('putVersionAsset', () => {
  it('accepts identical repeated writes without changing existing metadata', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await ctx.env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { marker: 'original' },
    });

    await expect(putVersionAsset(ctx, key, bytes)).resolves.toBeUndefined();
    await expect(putVersionAsset(ctx, key, new Uint8Array(bytes))).resolves.toBeUndefined();

    const stored = await storedObject();
    expect(stored.httpMetadata?.contentType).toBe('image/png');
    expect(stored.customMetadata).toEqual({ marker: 'original' });
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
  });

  it('rejects different bytes at an existing key without changing the original', async () => {
    const original = new Uint8Array([0, 1, 2, 255]);
    const collision = new Uint8Array([0, 1, 3, 255]);
    await putVersionAsset(ctx, key, original);

    const attempt = putVersionAsset(ctx, key, collision);
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toMatchObject({ code: 'TEMPLATE_ASSET_CONFLICT', status: 409 });
    expect(new Uint8Array(await (await storedObject()).arrayBuffer())).toEqual(original);
  });

  it('allows only one of two concurrent creates with different bytes', async () => {
    const first = new Uint8Array([4, 5, 6]);
    const second = new Uint8Array([4, 5, 7]);
    const results = await Promise.allSettled([
      putVersionAsset(ctx, key, first),
      putVersionAsset(ctx, key, second),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status !== 'rejected') throw new Error('Missing rejected writer');
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect(rejected.reason).toMatchObject({ code: 'TEMPLATE_ASSET_CONFLICT', status: 409 });
    const winner = results[0]?.status === 'fulfilled' ? first : second;
    expect(new Uint8Array(await (await storedObject()).arrayBuffer())).toEqual(winner);
  });
});
