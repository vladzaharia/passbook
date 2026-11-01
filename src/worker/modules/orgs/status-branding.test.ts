import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { orgBrandingAssets, putBrandingImage } from './branding.ts';

const fake = fakeAuth();
let appEnv: AppEnv;
const app = createApp({ stores: fake.stores });
const call = (method: string, path: string, body?: unknown) =>
  app.request(
    `/api/v1/orgs${path}`,
    {
      method,
      headers: { ...fake.admin(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
    appEnv,
  );
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const actionsOf = async (id: string) =>
  (
    await all<{ action: string }>(
      env.DB,
      'SELECT action FROM audit_log WHERE target_id = ? ORDER BY id',
      [id],
    )
  ).map((a) => a.action);

beforeAll(async () => {
  appEnv = await makeEnv();
});

describe('org status', () => {
  it('suspends and reactivates with org.suspend and org.reactivate', async () => {
    const org = await makeOrg(fixtures(appEnv));
    const off = await call('POST', `/${org.id}/status`, { status: 'suspended' });
    expect(((await off.json()) as { status: string }).status).toBe('suspended');
    const on = await call('POST', `/${org.id}/status`, { status: 'active' });
    expect(((await on.json()) as { status: string }).status).toBe('active');
    expect(await actionsOf(org.id)).toEqual(['org.suspend', 'org.reactivate']);
    expect((await call('POST', '/missing/status', { status: 'active' })).status).toBe(404);
  });
});

describe('org search', () => {
  it('matches the name or slug', async () => {
    const f = fixtures(appEnv);
    const hit = await makeOrg(f, { name: 'Zebra Climbing' });
    await makeOrg(f, { name: 'Other' });
    const body = (await (await call('GET', '?q=zebra')).json()) as { items: { id: string }[] };
    expect(body.items.map((o) => o.id)).toEqual([hit.id]);
  });
});

describe('pass branding images', () => {
  it('rejects a wrong icon size with the expected size', async () => {
    const org = await makeOrg(fixtures(appEnv));
    const res = await call('PUT', `/${org.id}/branding/icon`, { x3: b64(makePng(100, 100)) });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { code: string; detail: string };
    expect(problem.code).toBe('IMAGE_SIZE');
    expect(problem.detail).toContain('114x114px');
  });

  it('stores @3x and @2x, records the image and keeps it across updates', async () => {
    const org = await makeOrg(fixtures(appEnv));
    const res = await call('PUT', `/${org.id}/branding/icon`, {
      x3: b64(makePng(114, 114)),
      x2: b64(makePng(76, 76)),
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { branding: { icon?: { w: number; h: number } } };
    expect(saved.branding.icon).toMatchObject({ w: 114, h: 114 });
    const logo = await call('PUT', `/${org.id}/branding/logo`, {
      x3: b64(makePng(480, 150)),
      x2: b64(makePng(320, 100)),
    });
    expect(logo.status).toBe(200);
    expect([...(await orgBrandingAssets(appEnv, org.id)).keys()].sort()).toEqual([
      'icon@2x.png',
      'icon@3x.png',
      'logo@2x.png',
      'logo@3x.png',
    ]);
    const patched = await call('PATCH', `/${org.id}`, {
      branding: {
        accent: '#0f766e',
        passColors: { background: '#0f172a', foreground: '#ffffff', label: '#94a3b8' },
      },
    });
    const body = (await patched.json()) as { branding: Record<string, unknown> };
    expect(body.branding.icon).toBeDefined();
    expect(body.branding.passColors).toMatchObject({ background: '#0f172a' });
    expect(await actionsOf(org.id)).toContain('org.update');
    const png = await call('GET', `/${org.id}/branding/icon/2x`);
    expect(png.headers.get('content-type')).toBe('image/png');
    const removed = await call('DELETE', `/${org.id}/branding/icon`);
    expect(((await removed.json()) as { branding: object }).branding).not.toHaveProperty('icon');
  });

  it('keeps only the @3x when no @2x can be made', async () => {
    const org = await makeOrg(fixtures(appEnv));
    const ctx = createServiceContext(appEnv);
    await putBrandingImage(
      ctx,
      { type: 'user', id: 'admin' },
      org.id,
      'logo',
      { x3: b64(makePng(300, 90)) },
      { resize: async () => null },
    );
    expect([...(await orgBrandingAssets(appEnv, org.id)).keys()]).toEqual(['logo@3x.png']);
  });
});
