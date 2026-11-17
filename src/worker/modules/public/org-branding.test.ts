import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, linkToken, orgManager } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { putBrandingImage } from '../orgs/branding.ts';
import { putPassAsset } from '../passes/asset-service.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';

const ORIGIN = 'https://wallet.test';
const admin = { type: 'user', id: 'admin-1' } as const;
const b64 = (png: Uint8Array) => btoa(String.fromCharCode(...png));
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fakeAuth(ORIGIN).stores });
  const manager = await orgManager(kit.fx, kit.ctx, kit.org.id);
  const icon = { x3: b64(makePng(114, 114)) };
  await putBrandingImage(kit.ctx, admin, kit.org.id, 'icon', icon, undefined, manager);
  const logo = { x3: b64(makePng(480, 150)) };
  await putBrandingImage(kit.ctx, admin, kit.org.id, 'logo', logo, undefined, manager);
});

const get = (path: string, env = kit.env, headers: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers }, env);
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe('org branding images on passes', () => {
  it('puts the uploaded logo and icon into the signed pass', async () => {
    const pass = await kit.pass();
    const files = unzipSync(
      await bytesOf(await get(`/p/${await linkToken(kit.env, pass)}/pass.pkpass`)),
    );
    expect(files['icon@3x.png']).toEqual(makePng(114, 114));
    expect(files['logo@3x.png']).toEqual(makePng(480, 150));
  });

  it('shows them on the pass page and serves them as assets', async () => {
    const pass = await kit.pass();
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(html).toContain(`/p/${await linkToken(kit.env, pass)}/assets/logo@3x.png?v=`);
    expect(html).not.toContain('/assets/icon@3x.png');
    const logo = await get(`/p/${await linkToken(kit.env, pass)}/assets/logo@3x.png`);
    expect(await bytesOf(logo)).toEqual(makePng(480, 150));
  });

  it('lets a per-pass override win over the org image of its slot', async () => {
    const pass = await kit.pass();
    const own = makePng(320, 100);
    await putPassAsset(jobCtxOf(kit), admin, pass.id, 'logo@2x.png', own, null);
    const files = unzipSync(
      await bytesOf(await get(`/p/${await linkToken(kit.env, pass)}/pass.pkpass`)),
    );
    expect(files['logo@2x.png']).toEqual(own);
    expect(files['logo@3x.png']).toBeUndefined();
    expect(files['icon@3x.png']).toEqual(makePng(114, 114));
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(html).toContain('/assets/logo@2x.png?v=');
    expect(html).not.toContain('/assets/logo@3x.png?v=');
    expect(
      await bytesOf(await get(`/p/${await linkToken(kit.env, pass)}/assets/logo@2x.png`)),
    ).toEqual(own);
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
    expect(await hit(await linkToken(kit.env, a), '9.9.9.1')).toBe(200);
    expect(await hit(await linkToken(kit.env, a), '9.9.9.2')).toBe(200);
    expect(await hit(await linkToken(kit.env, a), '9.9.9.3')).toBe(429);
    // The same proxy still reaches every other token, and another network reaches this one.
    expect(await hit(await linkToken(kit.env, b), '9.9.9.1')).toBe(200);
    expect(await hit(await linkToken(kit.env, a), '8.8.8.8')).toBe(200);
  });

  it('falls back to the IP for a malformed token', async () => {
    const env = { ...kit.env, RL_PUBLIC_ASSET: fakeLimiter(1) as unknown as RateLimit };
    const hit = async (token: string) =>
      (await get(`/p/${token}/assets/icon@3x.png`, env, { 'cf-connecting-ip': '7.7.7.7' })).status;
    expect(await hit('short1')).toBe(404);
    expect(await hit('short2')).toBe(429);
  });

  const seedMisses = (prefix: string, count: number) =>
    run(kit.env.DB, 'INSERT OR REPLACE INTO counters (key, window_start, count) VALUES (?, ?, ?)', [
      `asset.miss:${prefix}`,
      Math.floor(Date.now() / 60_000) * 60_000,
      count,
    ]);
  const missCount = async (prefix: string) =>
    (
      await first<{ count: number }>(kit.env.DB, 'SELECT count FROM counters WHERE key = ?', [
        `asset.miss:${prefix}`,
      ])
    )?.count ?? 0;
  const randomToken = () => `${'a'.repeat(21)}${Math.random().toString(36).slice(2, 8)}`;

  it('charges only misses, per prefix, and never valid requests', async () => {
    const a = await kit.pass();
    const hit = async (token: string, ip: string) => {
      const res = await get(`/p/${token}/assets/icon@3x.png`, kit.env, { 'cf-connecting-ip': ip });
      await res.arrayBuffer();
      return res.status;
    };
    await run(kit.env.DB, "DELETE FROM counters WHERE key LIKE 'asset.miss:%'");
    for (let i = 0; i < 5; i++) expect(await hit(await linkToken(kit.env, a), '5.5.5.1')).toBe(200);
    expect(await missCount('5.5.5.0/24')).toBe(0);
    expect(await hit(randomToken(), '5.5.5.2')).toBe(404);
    expect(await hit(randomToken(), '5.5.5.3')).toBe(404);
    expect(await missCount('5.5.5.0/24')).toBe(2);
  });

  it('refuses a prefix over the miss threshold before any token lookup, valid tokens included', async () => {
    const a = await kit.pass();
    await seedMisses('4.4.4.0/24', 300);
    const hit = async (token: string, ip: string) =>
      (await get(`/p/${token}/assets/icon@3x.png`, kit.env, { 'cf-connecting-ip': ip })).status;
    expect(await hit(await linkToken(kit.env, a), '4.4.4.9')).toBe(429);
    expect(await hit(randomToken(), '4.4.4.10')).toBe(429);
    // Refused requests are not charged further, and other prefixes are untouched.
    expect(await missCount('4.4.4.0/24')).toBe(300);
    expect(await hit(await linkToken(kit.env, a), '4.4.5.9')).toBe(200);
  });

  it('keys IPv6 by the normalized /64', async () => {
    const a = await kit.pass();
    await seedMisses('2001:0db8:0001:0002::/64', 300);
    const hit = async (ip: string) =>
      (
        await get(`/p/${await linkToken(kit.env, a)}/assets/icon@3x.png`, kit.env, {
          'cf-connecting-ip': ip,
        })
      ).status;
    expect(await hit('2001:DB8:1:2::7')).toBe(429);
    expect(await hit('2001:db8:1:2:abcd:ef01:2345:6789')).toBe(429);
    expect(await hit('2001:db8:1:3::7')).toBe(200);
  });
});
