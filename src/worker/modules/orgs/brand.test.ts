import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { crc32 } from '../templates/package/hash.ts';
import { type Api, auditOf, setupApi } from '../webhooks/api-test-fixtures.ts';
import { orgBrandOf, storedBrandingOf } from './brand.ts';

let api: Api;
let orgId: string;
let other: string;
let admin: Record<string, string>;

beforeAll(async () => {
  api = await setupApi();
  orgId = api.rig.orgId;
  other = await api.otherOrg();
  admin = await api.member(['org_admin']);
});
afterAll(() => undefined);

const b64 = (bytes: Uint8Array) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const text = (s: string) => new TextEncoder().encode(s);
const put = (png: Uint8Array, headers = admin, org = orgId) =>
  api.call('PUT', `/api/v1/brand/web-logo?orgId=${org}`, { png: b64(png) }, headers);
const kit = (headers = admin, org = orgId) =>
  api.call('GET', `/api/v1/brand?orgId=${org}`, undefined, headers);
const patch = (body: unknown, headers = admin, org = orgId) =>
  api.call('PATCH', `/api/v1/brand?orgId=${org}`, body, headers);
const ctx = () => createServiceContext(api.rig.kit.env, { clock: api.rig.kit.clock });

/** An APNG: a still PNG with an animation control chunk after the header. */
function animated(png: Uint8Array): Uint8Array {
  const body = new Uint8Array(8);
  const chunk = new Uint8Array(20);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 8);
  chunk.set(text('acTL'), 4);
  chunk.set(body, 8);
  view.setUint32(16, crc32(chunk, 4, 16));
  const at = 8 + 25;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at));
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}

describe('web logo upload', () => {
  it('stores a PNG content-addressed and points the kit at a same-origin path', async () => {
    const png = makePng(400, 100);
    const sha = await sha256Hex(png);
    const res = await put(png);
    expect(res.status).toBe(200);
    expect(res.json.branding.web).toEqual({ sha, w: 400, h: 100 });
    const body = (await kit()).json;
    expect(body.webLogo).toEqual({ url: `/brand/${orgId}/${sha}.png`, w: 400, h: 100 });
    expect(body.webLogo.url.startsWith('/')).toBe(true);
    expect((await auditOf(api.rig.db, 'org.update')).at(-1)?.detail).toContain('branding.web');
  });

  it('serves it publicly as an image only, locked down and immutable', async () => {
    const png = makePng(300, 80);
    const sha = await sha256Hex(png);
    await put(png);
    const raw = await fetchAsset(`/brand/${orgId}/${sha}.png`);
    expect(raw.status).toBe(200);
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(png);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(raw.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(raw.headers.get('cache-control')).toContain('immutable');
  });

  it('refuses anything that is not a still PNG within the caps', async () => {
    const cases: [string, Uint8Array, string][] = [
      [
        'svg',
        text('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
        'IMAGE_INVALID',
      ],
      ['jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(80).fill(0)]), 'IMAGE_INVALID'],
      ['html', text('<html><body>x</body></html>'.repeat(5)), 'IMAGE_INVALID'],
      ['apng', animated(makePng(64, 64)), 'IMAGE_ANIMATED'],
      ['too wide', makePng(1025, 100), 'IMAGE_SIZE'],
      ['too tall', makePng(100, 513), 'IMAGE_SIZE'],
      ['tiny', makePng(8, 8), 'IMAGE_SIZE'],
    ];
    for (const [name, bytes, code] of cases) {
      const res = await put(bytes);
      expect(res.status, name).toBe(422);
      expect(res.json.code, name).toBe(code);
    }
  });

  it('refuses a PNG over 512 KB', async () => {
    const big = new Uint8Array(512 * 1024 + 1);
    big.set(makePng(64, 64));
    const res = await put(big);
    expect([413, 422]).toContain(res.status);
  });

  it('never serves a file that was not stored for that org', async () => {
    const png = makePng(200, 50);
    const sha = await sha256Hex(png);
    await put(png);
    expect((await fetchAsset(`/brand/${other}/${sha}.png`)).status).toBe(404);
    expect((await fetchAsset(`/brand/${orgId}/${'0'.repeat(64)}.png`)).status).toBe(404);
    for (const file of [`${sha}.svg`, `${sha}`, `${sha}.png.html`])
      expect((await fetchAsset(`/brand/${orgId}/${file}`)).status, file).toBe(404);
  });

  it('removes the logo from the kit', async () => {
    await put(makePng(200, 50));
    const res = await api.call('DELETE', `/api/v1/brand/web-logo?orgId=${orgId}`, undefined, admin);
    expect(res.status).toBe(200);
    expect((await kit()).json.webLogo).toBeNull();
  });

  it('keeps the web logo when the org form saves its other branding', async () => {
    const png = makePng(200, 50);
    const sha = await sha256Hex(png);
    await put(png);
    const res = await api.call(
      'PATCH',
      `/api/v1/orgs/${orgId}`,
      { branding: { accent: '#112233', web: { sha: 'f'.repeat(64), w: 1, h: 1 }, mark: 'none' } },
      admin,
    );
    expect(res.status).toBe(200);
    const body = (await kit()).json;
    expect(body.webLogo.url).toContain(sha);
    expect(body.markChosen).not.toBe('none');
  });
});

const plan = (value: string | null) =>
  value === null
    ? run(api.rig.db, "DELETE FROM org_entitlement_overrides WHERE key = 'brand.mark'")
    : run(
        api.rig.db,
        "INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'brand.mark', ?, 1)",
        [orgId, JSON.stringify(value)],
      );

describe('mark level', () => {
  afterEach(async () => {
    await plan(null);
    await run(
      api.rig.db,
      "UPDATE orgs SET branding = json_remove(branding, '$.mark') WHERE id = ?",
      [orgId],
    );
  });

  it('a plan whose least is full allows full only, and refuses the rest', async () => {
    await plan('full');
    expect((await kit()).json.markAllowed).toEqual(['full']);
    for (const mark of ['small', 'none']) {
      const refused = await patch({ mark });
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe('BRAND_MARK_NOT_ALLOWED');
    }
    expect((await patch({ mark: 'full' })).status).toBe(200);
  });

  it('a quiet plan allows small and full, a none plan allows all three', async () => {
    await plan('quiet');
    expect((await kit()).json.markAllowed).toEqual(['small', 'full']);
    expect((await patch({ mark: 'small' })).status).toBe(200);
    expect((await orgBrandOf(ctx(), orgId)).mark).toBe('small');
    expect((await patch({ mark: 'none' })).json.code).toBe('BRAND_MARK_NOT_ALLOWED');
    await plan('none');
    expect((await kit()).json.markAllowed).toEqual(['none', 'small', 'full']);
    expect((await patch({ mark: 'none' })).status).toBe(200);
    expect((await orgBrandOf(ctx(), orgId)).mark).toBe('none');
  });

  it('shows the nearest allowed mark above a stored one the plan no longer allows, and keeps the stored choice', async () => {
    await plan('quiet');
    await run(
      api.rig.db,
      "UPDATE orgs SET branding = json_set(branding, '$.mark', 'none') WHERE id = ?",
      [orgId],
    );
    expect((await orgBrandOf(ctx(), orgId)).mark).toBe('small');
    await plan('full');
    expect((await orgBrandOf(ctx(), orgId)).mark).toBe('full');
    expect((await kit()).json).toMatchObject({
      mark: 'full',
      markChosen: 'none',
      markAllowed: ['full'],
    });
  });

  it('fails closed to full when the plan has no brand.mark value', async () => {
    await run(
      api.rig.db,
      "UPDATE orgs SET branding = json_set(branding, '$.mark', 'none') WHERE id = ?",
      [orgId],
    );
    await plan('bogus');
    expect((await orgBrandOf(ctx(), orgId)).mark).toBe('full');
  });

  it('refuses unreadable stored branding with a stable code, not a SyntaxError', () => {
    // The column is CHECK json_valid, so this is the guard for a row that got past it.
    expect(() => storedBrandingOf(ctx(), { id: orgId, branding: 'not json' })).toThrow(
      expect.objectContaining({ code: 'BRANDING_UNREADABLE', status: 500 }),
    );
    expect(storedBrandingOf(ctx(), { id: orgId, branding: '{"mark":"none"}' })).toMatchObject({
      stored: { mark: 'none' },
    });
  });

  it('sets and clears the accent, and refuses a non-hex one', async () => {
    expect((await patch({ accent: '#112233' })).status).toBe(200);
    expect((await orgBrandOf(ctx(), orgId)).accent).toBe('#112233');
    expect((await patch({ accent: null })).status).toBe(200);
    expect((await orgBrandOf(ctx(), orgId)).accent).toBeNull();
    expect((await patch({ accent: 'red;}' })).status).toBe(422);
  });
});

describe('who may use the brand kit', () => {
  it('lets a key with brand:manage read and change its own org', async () => {
    const key = await api.key({ scopes: ['brand:manage'] });
    expect((await api.call('GET', '/api/v1/brand', undefined, key)).status).toBe(200);
    expect((await api.call('PATCH', '/api/v1/brand', { accent: '#0a0b0c' }, key)).status).toBe(200);
    expect(
      (await api.call('PUT', '/api/v1/brand/web-logo', { png: b64(makePng(120, 40)) }, key)).status,
    ).toBe(200);
    expect((await auditOf(api.rig.db, 'org.update')).at(-1)?.actor_type).toBe('api_key');
  });

  it('refuses keys without the scope, and a key of another org', async () => {
    const wrong = await api.key({ scopes: ['passes:read', 'passes:write', 'connections:write'] });
    expect((await api.call('GET', '/api/v1/brand', undefined, wrong)).status).toBe(403);
    expect((await api.call('PATCH', '/api/v1/brand', { accent: '#0a0b0c' }, wrong)).status).toBe(
      403,
    );
    const foreign = await api.key({ scopes: ['brand:manage'], orgId: other });
    expect((await kit(foreign)).status).toBe(403);
    expect((await patch({ accent: '#0a0b0c' }, foreign)).status).toBe(403);
  });

  it('keeps the brand:manage scope out of every other route', async () => {
    const key = await api.key({ scopes: ['brand:manage'] });
    expect(
      (await api.call('PATCH', `/api/v1/orgs/${orgId}`, { name: 'Hijack' }, key)).status,
    ).toBeGreaterThanOrEqual(401);
    expect(
      (await api.call('GET', `/api/v1/webhook-endpoints?orgId=${orgId}`, undefined, key)).status,
    ).toBe(403);
  });

  it('keeps one org out of another org', async () => {
    expect((await kit(admin, other)).status).toBe(403);
    expect((await patch({ accent: '#0a0b0c' }, admin, other)).status).toBe(403);
    expect((await put(makePng(100, 40), admin, other)).status).toBe(403);
    expect((await orgBrandOf(ctx(), other)).accent).toBeNull();
  });

  it('lets a reader see the kit but not change it', async () => {
    const reader = await api.member(['read_only']);
    const read = await kit(reader);
    expect([200, 403]).toContain(read.status);
    expect((await patch({ accent: '#0a0b0c' }, reader)).status).toBe(403);
    expect((await put(makePng(100, 40), reader)).status).toBe(403);
    expect((await api.call('GET', `/api/v1/brand?orgId=${orgId}`)).status).toBe(401);
  });
});

describe('the dirty trigger', () => {
  it('ignores the web logo and mark, which never reach a wallet pass', async () => {
    const row = await api.rig.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'wallet_provider_dirty_org'")
      .first<{ sql: string }>();
    expect(row?.sql).toContain("json_remove(OLD.branding, '$.web', '$.mark')");
  });
});

async function fetchAsset(path: string): Promise<Response> {
  const { env } = api.rig.kit;
  const { createApp } = await import('../../app.ts');
  const { denyAllStores } = await import('../../platform/auth.ts');
  const app = createApp({ stores: denyAllStores, clock: api.rig.kit.clock });
  const ctxStub = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  return app.request(`https://wallet.test${path}`, {}, env, ctxStub);
}
