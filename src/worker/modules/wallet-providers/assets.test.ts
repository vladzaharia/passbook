import { describe, expect, it } from 'vitest';
import { makeEnv, makeTemplate } from '../../../../test/helpers/index.ts';
import { artOutput, artRule } from '../../../passkit/template/wallets/art-rules.ts';
import { createApp } from '../../app.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { behaviors } from '../templates/build-check.ts';
import { analyzePackage } from '../templates/package/analyze.ts';
import { basicPackage, makePng } from '../templates/package/fixtures.ts';
import { sha256BytesHex } from '../templates/package/hash.ts';
import { parsePng } from '../templates/package/png.ts';
import { type ArtTransform, artTransformFromBinding, deriveWalletArt } from './assets.ts';

const ORIGIN = 'https://wallet.test';

/** Stands in for the Images binding: a PNG of the requested size. */
const calls: { width: number; height?: number; fit: string }[] = [];
const transform: ArtTransform = async (bytes, size) => {
  calls.push(size);
  // A downscale names only its width: the height follows the source's aspect, as the Images binding gives it.
  const source = parsePng(bytes);
  const height =
    size.height ??
    ('error' in source ? size.width : Math.round((source.height * size.width) / source.width));
  return makePng(size.width, height);
};

async function setup(assets: Record<string, Uint8Array>) {
  const env = await makeEnv();
  const { registry } = makeTemplate();
  const template = registry.add({
    ...(() => {
      const base = makeTemplate().resolved;
      return { id: 'tpl-art', manifest: base.manifest, passJson: base.passJson };
    })(),
    assets,
  });
  return { env, registry, template, app: createApp() };
}

const get = (
  app: ReturnType<typeof createApp>,
  env: Awaited<ReturnType<typeof makeEnv>>,
  path: string,
) => app.request(`${ORIGIN}${path}`, {}, env);

describe('wallet art rules', () => {
  it('cuts to the target size and never enlarges', () => {
    const logo = artRule('google', 'logo');
    if (!logo) throw new Error('no rule');
    expect(artOutput(logo, 1000, 1000)).toEqual({ width: 660, height: 660, crop: true });
    expect(artOutput(logo, 1000, 800)).toEqual({ width: 660, height: 660, crop: true });
    expect(artOutput(logo, 700, 1400)).toEqual({ width: 660, height: 660, crop: true });
    expect(artOutput(logo, 659, 900)).toBeNull();
    const hero = artRule('google', 'hero');
    if (!hero) throw new Error('no rule');
    expect(artOutput(hero, 2064, 1624)).toEqual({ width: 1032, height: 812, crop: false });
    expect(artOutput(hero, 1032, 400)).toEqual({ width: 1032, height: 400, crop: false });
    expect(artOutput(hero, 1000, 400)).toBeNull();
  });
});

describe('upload size checks for wallets art', () => {
  const starterManifest = { schema: 1, name: 'Card' };
  const analyze = async (files: Record<string, Uint8Array>) => {
    const result = await analyzePackage(
      basicPackage({ 'wallet.template.json': JSON.stringify(starterManifest), ...files }),
      { uploaded: true, fallbackName: 'Card', behaviors },
    );
    return result.report.issues.filter((i) => i.severity === 'error').map((i) => i.code);
  };

  it('rejects a Google logo that is too small or not square', async () => {
    expect(await analyze({ 'wallets/google/logo.png': makePng(300, 300) })).toContain(
      'WALLET_ART_SIZE',
    );
    expect(await analyze({ 'wallets/google/logo.png': makePng(800, 700) })).toContain(
      'WALLET_ART_SIZE',
    );
  });

  it('accepts art that fits and slots without a rule', async () => {
    expect(await analyze({ 'wallets/google/logo.png': makePng(700, 700) })).not.toContain(
      'WALLET_ART_SIZE',
    );
    expect(await analyze({ 'wallets/google/spare.png': makePng(8, 8) })).not.toContain(
      'WALLET_ART_SIZE',
    );
  });
});

describe('deriveWalletArt', () => {
  it('has no transform without an Images binding', async () => {
    expect(
      await artTransformFromBinding(undefined)(makePng(8, 8), {
        width: 4,
        height: 4,
        fit: 'cover',
      }),
    ).toBeNull();
  });

  it('derives a PNG at the provider size and stores it under its hash', async () => {
    calls.length = 0;
    const { env, registry, template } = await setup({
      'wallets/google/logo.png': makePng(900, 1000),
    });
    const art = await deriveWalletArt(
      env,
      registry,
      template,
      { target: 'google', slot: 'logo', asset: 'wallets/google/logo.png' },
      transform,
    );
    expect(calls).toEqual([{ width: 660, height: 660, fit: 'cover' }]);
    expect(art).toMatchObject({ width: 660, height: 660 });
    const stored = await env.BUCKET.get(`wallet-art/${art?.sha256}`);
    const bytes = new Uint8Array((await stored?.arrayBuffer()) ?? []);
    expect(await sha256BytesHex(bytes)).toBe(art?.sha256);
    expect(art?.path).toBe(`/w/i/${art?.sha256}.png`);
  });

  it('keeps art already at size and skips art below the minimum', async () => {
    calls.length = 0;
    const { env, registry, template } = await setup({
      'wallets/google/logo.png': makePng(660, 660),
      'wallets/google/hero.png': makePng(800, 300),
    });
    const logo = await deriveWalletArt(
      env,
      registry,
      template,
      { target: 'google', slot: 'logo', asset: 'wallets/google/logo.png' },
      transform,
    );
    expect(logo?.sha256).toBe(await sha256BytesHex(makePng(660, 660)));
    expect(calls).toEqual([]);
    expect(
      await deriveWalletArt(
        env,
        registry,
        template,
        { target: 'google', slot: 'hero', asset: 'wallets/google/hero.png' },
        transform,
      ),
    ).toBeNull();
  });

  it('refuses assets that are not template art', async () => {
    const { env, registry, template } = await setup({ 'member-photo.png': makePng(900, 900) });
    const request = { target: 'google', slot: 'logo', asset: 'member-photo.png' } as const;
    expect(await deriveWalletArt(env, registry, template, request, transform)).toBeNull();
    expect(
      await deriveWalletArt(
        env,
        registry,
        template,
        { ...request, asset: 'missing.png' },
        transform,
      ),
    ).toBeNull();
    const hash = await sha256BytesHex(makePng(900, 900));
    expect(await env.BUCKET.head(`wallet-art/${hash}`)).toBeNull();
  });
});

describe('GET /w/i/:sha256', () => {
  it('serves template art with immutable public headers', async () => {
    const { env, registry, template, app } = await setup({
      'wallets/google/logo.png': makePng(660, 660),
    });
    const art = await deriveWalletArt(
      env,
      registry,
      template,
      { target: 'google', slot: 'logo', asset: 'wallets/google/logo.png' },
      transform,
    );
    for (const path of [art?.path, `/w/i/${art?.sha256}`]) {
      const res = await get(app, env, path as string);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('etag')).toBe(`"${art?.sha256}"`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(makePng(660, 660));
    }
  });

  it('404s an unknown hash, a bad name and a personal object', async () => {
    const { env, app } = await setup({});
    const personal = makePng(10, 10);
    const hash = await sha256BytesHex(personal);
    await env.BUCKET.put(`wallet-art/${hash}`, personal);
    await env.BUCKET.put(`pass-assets/${hash}`, personal);
    for (const path of [
      `/w/i/${'0'.repeat(64)}.png`,
      `/w/i/${hash}.png`,
      '/w/i/not-a-hash.png',
      `/w/i/${hash.toUpperCase()}.png`,
      `/w/i/${hash}.jpg`,
    ]) {
      const res = await get(app, env, path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type')).not.toBe('image/png');
    }
  });

  it('is rate limited', async () => {
    const { env, app } = await setup({});
    const limited = { ...env, RL_PUBLIC_ASSET: fakeLimiter(1) as unknown as RateLimit };
    const path = `/w/i/${'1'.repeat(64)}.png`;
    expect((await get(app, limited, path)).status).toBe(404);
    expect((await get(app, limited, path)).status).toBe(429);
  });
});
