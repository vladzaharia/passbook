import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { BundleSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { seedBundlePrincipal } from './test-auth-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores, clock: kit.clock });
});

const makePass = (mode: 'live' | 'test' = 'live') =>
  createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: kit.template.version,
    input: { memberName: 'Public Bundle' },
    source: 'manual',
    execution: { kind: 'system' },
    mode,
    actor: { type: 'system', id: null },
  });

async function bundleWith(count: number, mode: 'live' | 'test' = 'live') {
  const passes = [];
  for (let i = 0; i < count; i++) passes.push(await makePass(mode));
  const headers = fake.admin({ mode });
  await seedBundlePrincipal(kit, fake, headers);
  const res = await app.request(
    `${ORIGIN}/api/v1/bundles`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: kit.org.id, name: 'Trip', passIds: passes.map((p) => p.id) }),
    },
    kit.env,
  );
  const bundle = BundleSchema.parse(await res.json());
  return { passes, bundle, headers, token: bundle.url?.split('/b/')[1] ?? '' };
}
const get = (path: string, headers: Record<string, string> = {}, env = kit.env) =>
  app.request(`${ORIGIN}${path}`, { headers }, env);
const events = (kind: string, passId: string) =>
  all<{ data: string; mode: string }>(
    kit.env.DB,
    'SELECT data, mode FROM pass_events WHERE pass_id = ? AND kind = ?',
    [passId, kind],
  );

describe('GET /b/:token', () => {
  it('renders every pass with its own add link and the add-all badge', async () => {
    const { passes, token } = await bundleWith(3);
    const res = await get(`/b/${token}`, {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('Add all to Apple Wallet');
    expect(html).toContain(`href="/b/${token}/passes.pkpasses"`);
    for (const p of passes) expect(html).toContain(`href="/b/${token}/${p.id}/pass.pkpass"`);
    expect(html).toContain('3 passes');
    // The pass tokens never reach the page.
    for (const p of passes) expect(html).not.toContain(p.downloadToken);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });

  it('hands off to the phone with a QR on desktop', async () => {
    const { token } = await bundleWith(2);
    const html = await (
      await get(`/b/${token}`, { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' })
    ).text();
    expect(html).toContain('wl-add-scan');
    expect(html).toContain('<svg');
  });

  it('gives Android a Show barcode row per pass and no Apple badge', async () => {
    const { passes, token } = await bundleWith(2);
    const html = await (
      await get(`/b/${token}`, {
        'user-agent':
          'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
      })
    ).text();
    for (const p of passes) {
      expect(html).toContain(`href="/b/${token}/${p.id}/barcode"`);
      expect(html).not.toContain(`/b/${token}/${p.id}/pass.pkpass`);
    }
    expect(html.match(/Show barcode/g)).toHaveLength(2);
    expect(html).not.toContain('Add all to Apple Wallet');
    expect(html).not.toContain('data-awb=');
    expect(html).toContain('Open on iPhone or Mac to add to Apple Wallet.');
  });

  it('serves a member barcode page under the bundle token, with nothing to save', async () => {
    const { passes, token } = await bundleWith(2);
    const res = await get(`/b/${token}/${passes[0]?.id}/barcode`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<svg');
    expect(html).not.toContain('data-offline');
    expect(html).not.toMatch(/<script\b/);
    expect(html).toContain(`href="/b/${token}"`);
    expect(res.headers.get('cache-control')).toContain('no-store');
    // A pass outside the bundle and a rotated token are 404 pages.
    const other = await makePass();
    expect((await get(`/b/${token}/${other.id}/barcode`)).status).toBe(404);
    expect((await get(`/b/${'a'.repeat(43)}/${passes[0]?.id}/barcode`)).status).toBe(404);
  });

  it('refuses a member barcode once the pass is voided or removed, and after the link rotates', async () => {
    const { passes, bundle, headers, token } = await bundleWith(3);
    const [voided, removed, live] = passes;
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided?.id]);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      Date.now(),
      removed?.id,
    ]);
    for (const p of [voided, removed]) {
      const res = await get(`/b/${token}/${p?.id}/barcode`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<svg');
    }
    expect((await get(`/b/${token}/${live?.id}/barcode`)).status).toBe(200);
    const rotate = await app.request(
      `${ORIGIN}/api/v1/bundles/${bundle.id}/rotate-link`,
      { method: 'POST', headers },
      kit.env,
    );
    expect(rotate.status).toBe(200);
    expect((await get(`/b/${token}/${live?.id}/barcode`)).status).toBe(404);
  });

  it('sets the privacy headers and a matching nonce', async () => {
    const { token } = await bundleWith(1);
    const res = await get(`/b/${token}`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /style-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(await res.text()).toContain(`<style nonce="${nonce}">`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('is 404 for an unknown or malformed token', async () => {
    expect((await get('/b/nope')).status).toBe(404);
    expect((await get(`/b/${'a'.repeat(43)}`)).status).toBe(404);
    await expectProblem(await get(`/b/${'a'.repeat(43)}/passes.pkpasses`), 404, 'LINK_NOT_FOUND');
  });

  it('records bundle.opened per pass, in the bundle mode, without the token', async () => {
    const { passes, token, bundle } = await bundleWith(2, 'test');
    await get(`/b/${token}`);
    for (const p of passes) {
      const rows = await events('bundle.opened', p.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.mode).toBe('test');
      expect(rows[0]?.data).toContain(bundle.id);
      expect(rows[0]?.data).not.toContain(token);
    }
  });
});

describe('downloads', () => {
  it('serves each pass and records bundle.downloaded', async () => {
    const { passes, token } = await bundleWith(2);
    const [a, b] = passes;
    const res = await get(`/b/${token}/${a?.id}/pass.pkpass`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.pkpass');
    expect(await events('bundle.downloaded', a?.id ?? '')).toHaveLength(1);
    expect(await events('bundle.downloaded', b?.id ?? '')).toHaveLength(0);
  });

  it('serves a .pkpasses of all addable passes and records one event each', async () => {
    const { passes, token } = await bundleWith(3);
    const res = await get(`/b/${token}/passes.pkpasses`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.pkpasses');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const text = new TextDecoder('latin1').decode(new Uint8Array(await res.arrayBuffer()));
    for (const p of passes) {
      expect(text).toContain(`${p.id}.pkpass`);
      expect(await events('bundle.downloaded', p.id)).toHaveLength(1);
    }
  });

  it('refuses a pass that is not in the bundle', async () => {
    const { token } = await bundleWith(1);
    const stray = await makePass();
    await expectProblem(await get(`/b/${token}/${stray.id}/pass.pkpass`), 404, 'LINK_NOT_FOUND');
    await expectProblem(
      await get(`/b/${token}/${stray.id}/assets/icon.png`),
      404,
      'LINK_NOT_FOUND',
    );
  });

  it('serves images under the bundle token', async () => {
    const { passes, token } = await bundleWith(1);
    const res = await get(`/b/${token}/${passes[0]?.id}/assets/icon.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    // Member photos are personal: never cached, like /p/*/assets.
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('rate limit', () => {
  it('limits /b per client IP and keeps assets out of the page bucket', async () => {
    const { token, passes } = await bundleWith(1);
    const limiter = fakeLimiter(1);
    const env = { ...kit.env, RL_PUBLIC: limiter as unknown as RateLimit };
    const hit = (ip: string) => get(`/b/${token}`, { 'cf-connecting-ip': ip }, env);
    expect((await hit('1.1.1.1')).status).toBe(200);
    const limited = await hit('1.1.1.1');
    expect(limited.status).toBe(429);
    expect((await hit('2.2.2.2')).status).toBe(200);
    for (let i = 0; i < 5; i++) await get(`/b/${token}/${passes[0]?.id}/assets/icon.png`, {}, env);
    expect((await get(`/b/${token}`, { 'cf-connecting-ip': '3.3.3.3' }, env)).status).toBe(200);
  });
});

describe('asset miss gate', () => {
  it('charges misses per prefix and refuses an over-threshold prefix before lookup', async () => {
    const { token, passes } = await bundleWith(1);
    const url = `/b/${token}/${passes[0]?.id}/assets/icon.png`;
    const key = 'asset.miss:9.9.9.0/24';
    await run(kit.env.DB, 'DELETE FROM counters WHERE key = ?', [key]);
    const as = (ip: string, path = url) => get(path, { 'cf-connecting-ip': ip });
    expect((await as('9.9.9.1')).status).toBe(200);
    expect(
      (await as('9.9.9.2', `/b/${'z'.repeat(27)}/${passes[0]?.id}/assets/icon.png`)).status,
    ).toBe(404);
    const count = () =>
      first<{ count: number }>(kit.env.DB, 'SELECT count FROM counters WHERE key = ?', [key]);
    expect((await count())?.count).toBe(1);
    await run(kit.env.DB, 'UPDATE counters SET count = 300 WHERE key = ?', [key]);
    expect((await as('9.9.9.3')).status).toBe(429);
    expect((await as('9.9.8.3')).status).toBe(200);
  });
});
