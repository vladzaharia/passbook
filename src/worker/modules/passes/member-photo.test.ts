import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import { crc32 } from '../../../passkit/index.ts';
import { MemberPhotoSchema } from '../../../shared/contracts/check-in.ts';
import { createApp } from '../../app.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { putPassAsset } from './asset-service.ts';
import { getMemberPhoto, putMemberPhoto, updateMemberPhoto } from './member-photo.ts';
import { getPass } from './repo.ts';
import { memberPhoto } from './repo-member-photo.ts';
import { expectValidZip, type Kit, setupKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
const actor = { type: 'system' as const, id: null };
const png = makePng(270, 270);
const encoded = btoa(String.fromCharCode(...png));
let kit: Kit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});
const api = (id: string, method = 'GET', body?: unknown, headers = fake.admin()) =>
  app.request(
    `${ORIGIN}/api/v1/passes/${id}/member-photo`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
async function files(id: string) {
  const pass = await getPass(kit.env.DB, id);
  const object = await kit.env.BUCKET.get(pass?.objectKey ?? '');
  const bytes = new Uint8Array(await object!.arrayBuffer());
  expectValidZip(bytes);
  return unzipSync(bytes);
}

describe('member photos', () => {
  it('strips ancillary metadata before private storage and Wallet signing', async () => {
    const pass = await kit.pass();
    const data = new TextEncoder().encode('tEXtComment\0Private camera location');
    const chunk = new Uint8Array(data.length + 8);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length - 4);
    chunk.set(data, 4);
    view.setUint32(chunk.length - 4, crc32(data));
    const original = new Uint8Array([...png.subarray(0, -12), ...chunk, ...png.subarray(-12)]);
    await putMemberPhoto(
      kit.ctx,
      actor,
      pass.id,
      { png: btoa(String.fromCharCode(...original)), includeInPass: true },
      null,
    );
    expect((await files(pass.id))['thumbnail@3x.png']).toEqual(png);
  });

  it('restores the previous photo when a Wallet rebuild fails', async () => {
    const pass = await kit.pass();
    await putMemberPhoto(kit.ctx, actor, pass.id, { png: encoded, includeInPass: false }, null);
    const before = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
    const resolve = kit.registry.resolve.bind(kit.registry);
    const spy = vi
      .spyOn(kit.registry, 'resolve')
      .mockImplementationOnce(resolve)
      .mockRejectedValueOnce(new Error('Signing unavailable'));
    try {
      await expect(updateMemberPhoto(kit.ctx, actor, pass.id, true, null)).rejects.toThrow(
        'Signing unavailable',
      );
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
    expect((await files(pass.id))['thumbnail@3x.png']).toBeUndefined();
  });
  it('keeps a scanner photo out of Wallet until explicitly enabled', async () => {
    const pass = await kit.pass();
    const version = pass.version;
    const response = await api(pass.id, 'PUT', { png: encoded });
    expect(response.status).toBe(200);
    const photo = MemberPhotoSchema.parse(await response.json());
    expect(photo).toMatchObject({ includeInPass: false, walletSupported: true });
    expect(photo.url).toContain('/member-photo/image?');
    expect((await getPass(kit.env.DB, pass.id))?.version).toBe(version);
    expect((await files(pass.id))['thumbnail@3x.png']).toBeUndefined();
    const image = await app.request(`${ORIGIN}${photo.url}`, { headers: fake.admin() }, kit.env);
    expect(image.status).toBe(200);
    expect(image.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  });

  it('signs the photo into Wallet and restores the original thumbnail when disabled', async () => {
    const pass = await kit.pass();
    const original = makePng(180, 180);
    await putPassAsset(kit.ctx, actor, pass.id, 'thumbnail@2x.png', original, null);
    await putMemberPhoto(kit.ctx, actor, pass.id, { png: encoded, includeInPass: true }, null);
    const included = await files(pass.id);
    expect(included['thumbnail@3x.png']).toEqual(png);
    expect(included['thumbnail@2x.png']).toBeUndefined();
    await updateMemberPhoto(kit.ctx, actor, pass.id, false, null);
    const restored = await files(pass.id);
    expect(restored['thumbnail@3x.png']).toBeUndefined();
    expect(restored['thumbnail@2x.png']).toEqual(original);
  });

  it('removes the photo from both the signed pass and private storage', async () => {
    const pass = await kit.pass();
    await putMemberPhoto(kit.ctx, actor, pass.id, { png: encoded, includeInPass: true }, null);
    const row = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
    const response = await api(pass.id, 'DELETE');
    expect(response.status).toBe(200);
    expect(MemberPhotoSchema.parse(await response.json()).url).toBeNull();
    expect((await files(pass.id))['thumbnail@3x.png']).toBeUndefined();
    expect(await kit.env.BUCKET.get(row!.r2_key)).toBeNull();
  });

  it.each([
    { png: 'invalid', code: 'MEMBER_PHOTO_ENCODING' },
    { png: btoa('not a PNG'), code: 'ASSET_NOT_PNG' },
    { png: btoa(String.fromCharCode(...makePng(180, 180))), code: 'MEMBER_PHOTO_DIMENSIONS' },
  ])('rejects malformed or incorrectly sized uploads: $code', async ({ png, code }) => {
    const pass = await kit.pass();
    const response = await api(pass.id, 'PUT', { png });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code });
    expect((await getMemberPhoto(kit.ctx, pass.id, null)).url).toBeNull();
  });

  it('requires authentication, write access, matching organization and mode', async () => {
    const pass = await kit.pass();
    expect((await api(pass.id, 'GET', undefined, {})).status).toBe(401);
    expect((await api(pass.id, 'PUT', { png: encoded }, fake.user())).status).toBe(403);
    const other = await makeOrg(kit.fx);
    await expect(getMemberPhoto(kit.ctx, pass.id, other.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      putMemberPhoto(
        kit.ctx,
        actor,
        pass.id,
        { png: encoded, includeInPass: false },
        { orgId: pass.orgId, mode: 'test', principal: 'api_key' },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
