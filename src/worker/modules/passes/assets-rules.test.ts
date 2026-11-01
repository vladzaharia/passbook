import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { IMAGE_RULES as VALIDATOR_RULES } from '../../../passkit/schema/validate-images.ts';
import { createApp } from '../../app.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { putPassAsset } from './asset-service.ts';
import { IMAGE_RULES } from './assets.ts';
import { listAssets } from './repo.ts';
import { type Kit, setupKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

const put = (id: string, name: string, bytes: Uint8Array) =>
  app.request(
    `${ORIGIN}/api/v1/passes/${id}/assets/${name}`,
    { method: 'PUT', headers: { ...fake.admin(), 'content-type': 'image/png' }, body: bytes },
    kit.env,
  );

describe('override image rules', () => {
  it('reads the same rule table as the engine validator', () => {
    expect(IMAGE_RULES).toBe(VALIDATOR_RULES);
  });

  it('names the expected size when an image does not fit its slot', async () => {
    const pass = await kit.pass();
    const res = await put(pass.id, 'artwork.png', makePng(540, 720));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe('ASSET_DIMENSIONS');
    expect(body.detail).toBe('artwork.png must be 358 × 448 px.');
    const thumb = await put(pass.id, 'thumbnail@2x.png', makePng(600, 600));
    expect(((await thumb.json()) as { detail: string }).detail).toContain('180 × 180 px');
  });

  it('derives @2x from a single @3x upload', async () => {
    const pass = await kit.pass();
    const resized: [number, number][] = [];
    await putPassAsset(
      kit.ctx,
      { type: 'user', id: null },
      pass.id,
      'thumbnail@3x.png',
      makePng(270, 270),
      null,
      {
        resize: async (_bytes, width, height) => {
          resized.push([width, height]);
          return makePng(width, height);
        },
      },
    );
    expect(resized).toEqual([[180, 180]]);
    const names = (await listAssets(kit.env.DB, pass.id)).map((a) => a.name).sort();
    expect(names).toEqual(['thumbnail@2x.png', 'thumbnail@3x.png']);
  });
});
