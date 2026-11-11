import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { BundleSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all } from '../../platform/db.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

const makePass = (mode: 'live' | 'test' = 'live') =>
  createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: kit.template.version,
    input: { memberName: 'Public Bundle' },
    source: 'manual',
    mode,
    actor: { type: 'system', id: null },
  });

async function bundleWith(count: number, mode: 'live' | 'test' = 'live') {
  const passes = [];
  for (let i = 0; i < count; i++) passes.push(await makePass(mode));
  const res = await app.request(
    `${ORIGIN}/api/v1/bundles`,
    {
      method: 'POST',
      headers: { ...fake.admin({ mode }), 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: kit.org.id, name: 'Trip', passIds: passes.map((p) => p.id) }),
    },
    kit.env,
  );
  const bundle = BundleSchema.parse(await res.json());
  return { passes, bundle, token: bundle.url.split('/b/')[1] ?? '' };
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
    expect((await get(`/b/${'a'.repeat(43)}/passes.pkpasses`)).status).toBe(404);
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
    expect((await get(`/b/${token}/${stray.id}/pass.pkpass`)).status).toBe(404);
    expect((await get(`/b/${token}/${stray.id}/assets/icon.png`)).status).toBe(404);
  });

  it('serves images under the bundle token', async () => {
    const { passes, token } = await bundleWith(1);
    const res = await get(`/b/${token}/${passes[0]?.id}/assets/icon.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
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
