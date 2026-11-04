import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { putBrandingImage } from '../orgs/branding.ts';
import { putPassAsset } from '../passes/asset-service.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { makePng } from '../templates/package/fixtures.ts';

const ORIGIN = 'https://wallet.test';
const admin = { type: 'user', id: 'admin-1' } as const;
const b64 = (png: Uint8Array) => btoa(String.fromCharCode(...png));
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fakeAuth(ORIGIN).stores });
  await putBrandingImage(kit.ctx, admin, kit.org.id, 'icon', { x3: b64(makePng(114, 114)) });
  await putBrandingImage(kit.ctx, admin, kit.org.id, 'logo', { x3: b64(makePng(480, 150)) });
});

const get = (path: string, env = kit.env, headers: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers }, env);
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe('org branding images on passes', () => {
  it('puts the uploaded logo and icon into the signed pass', async () => {
    const pass = await kit.pass();
    const files = unzipSync(await bytesOf(await get(`/p/${pass.downloadToken}/pass.pkpass`)));
    expect(files['icon@3x.png']).toEqual(makePng(114, 114));
    expect(files['logo@3x.png']).toEqual(makePng(480, 150));
  });

  it('shows them on the pass page and serves them as assets', async () => {
    const pass = await kit.pass();
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(html).toContain(`/p/${pass.downloadToken}/assets/logo@3x.png?v=`);
    expect(html).toContain(`/p/${pass.downloadToken}/assets/icon@3x.png?v=`);
    const logo = await get(`/p/${pass.downloadToken}/assets/logo@3x.png`);
    expect(await bytesOf(logo)).toEqual(makePng(480, 150));
  });

  it('lets a per-pass override win over the org image of its slot', async () => {
    const pass = await kit.pass();
    const own = makePng(320, 100);
    await putPassAsset(kit.ctx, admin, pass.id, 'logo@2x.png', own, null);
    const files = unzipSync(await bytesOf(await get(`/p/${pass.downloadToken}/pass.pkpass`)));
    expect(files['logo@2x.png']).toEqual(own);
    expect(files['logo@3x.png']).toBeUndefined();
    expect(files['icon@3x.png']).toEqual(makePng(114, 114));
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(html).toContain('/assets/logo@2x.png?v=');
    expect(html).not.toContain('/assets/logo@3x.png?v=');
    expect(await bytesOf(await get(`/p/${pass.downloadToken}/assets/logo@2x.png`))).toEqual(own);
  });
});

describe('asset rate limit', () => {
  it('limits per token and IP prefix, not per IP', async () => {
    const a = await kit.pass();
    const b = await kit.pass();
    const env = { ...kit.env, RL_PUBLIC_ASSET: fakeLimiter(2) as unknown as RateLimit };
    const hit = async (token: string, ip: string) => {
      const res = await get(`/p/${token}/assets/icon@3x.png`, env, { 'cf-connecting-ip': ip });
      await res.arrayBuffer();
      return res.status;
    };
    expect(await hit(a.downloadToken, '9.9.9.1')).toBe(200);
    expect(await hit(a.downloadToken, '9.9.9.2')).toBe(200);
    expect(await hit(a.downloadToken, '9.9.9.3')).toBe(429);
    // The same proxy still reaches every other token, and another network reaches this one.
    expect(await hit(b.downloadToken, '9.9.9.1')).toBe(200);
    expect(await hit(a.downloadToken, '8.8.8.8')).toBe(200);
  });

  it('falls back to the IP for a malformed token', async () => {
    const env = { ...kit.env, RL_PUBLIC_ASSET: fakeLimiter(1) as unknown as RateLimit };
    const hit = async (token: string) =>
      (await get(`/p/${token}/assets/icon@3x.png`, env, { 'cf-connecting-ip': '7.7.7.7' })).status;
    expect(await hit('short1')).toBe(404);
    expect(await hit('short2')).toBe(429);
  });
});
