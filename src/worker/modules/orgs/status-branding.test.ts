/// <reference types="vite/client" />

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { readBranding } from '../passes/branding.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { generatedSource, syncBakedTemplates } from '../templates/sync.ts';
import { fakeAssets } from '../templates/testing.ts';
import { deleteBrandingImage, putBrandingImage } from './branding.ts';
import { brandingFiles, brandingKey } from './branding-files.ts';
import { BRANDING_GC_GRACE_MS, sweepBrandingGc } from './branding-gc.ts';

const clock = new ManualClock();
const app = createApp({
  stores: (env) => ({ ...denyAllStores, sessions: createSessionStore(env, clock) }),
  clock,
});
let f: Fixtures;
let platformAdmin: SessionFixture;
let orgAdmin: SessionFixture;
let appEnv: AppEnv;
const call = (method: string, path: string, body?: unknown, headers = platformAdmin.headers) =>
  app.request(
    `/api/v1/orgs${path}`,
    {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
    appEnv,
  );
const tenantCall = (method: string, path: string, body?: unknown) =>
  call(method, path, body, orgAdmin.headers);
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
  const assets = fakeAssets();
  const bakedFiles = import.meta.glob<string>('../../../../templates/**/*.{png,strings}', {
    eager: true,
    query: '?url&inline',
    import: 'default',
  });
  for (const template of generatedSource.templates) {
    const entries = [
      ...template.assets.map((asset) => ({ name: asset.name, path: asset.source.path })),
      ...template.extras,
    ];
    for (const entry of entries) {
      const data = bakedFiles[`../../../../templates/${template.slug}/${entry.name}`];
      if (!data?.startsWith('data:') || !data.includes(';base64,'))
        throw new Error(`Missing baked fixture: ${template.slug}/${entry.name}`);
      assets.files.set(
        entry.path,
        Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (c) => c.charCodeAt(0)),
      );
    }
  }
  appEnv = await makeEnv({ ASSETS: assets });
  await syncBakedTemplates(createServiceContext(appEnv, { clock }));
  f = fixtures(appEnv, clock);
  const platformUser = await makeUser(f);
  const tenantUser = await makeUser(f);
  platformAdmin = await makeSession(f, { userId: platformUser.id, roles: ['admin', 'user'] });
  orgAdmin = await makeSession(f, { userId: tenantUser.id });
}, 60_000);

async function join(orgId: string) {
  const invitationId = f.ids.id();
  const now = clock.now();
  await run(
    appEnv.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [
      invitationId,
      orgId,
      '["org_admin"]',
      f.ids.token(),
      now,
      now + 3600_000,
      now,
      orgAdmin.userId,
    ],
  );
  await run(
    appEnv.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), orgId, orgAdmin.userId, invitationId, '["org_admin"]', now],
  );
}

async function storedBranding(orgId: string): Promise<Record<string, unknown>> {
  const row = await first<{ branding: string }>(
    appEnv.DB,
    'SELECT branding FROM orgs WHERE id = ?',
    [orgId],
  );
  if (!row) throw new Error('Organization not found.');
  return JSON.parse(row.branding) as Record<string, unknown>;
}

describe('org status', () => {
  it('suspends and reactivates with org.suspend and org.reactivate', async () => {
    const org = await makeOrg(fixtures(appEnv));
    const projection = {
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: expect.any(Number),
      counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
      countsCapped: false,
    };
    const off = await call('POST', `/${org.id}/status`, { status: 'suspended' });
    expect(off.status).toBe(200);
    const suspended = await off.json();
    expect(suspended).toEqual({ ...projection, status: 'suspended' });
    const on = await call('POST', `/${org.id}/status`, { status: 'active' });
    expect(on.status).toBe(200);
    const active = await on.json();
    expect(active).toEqual({ ...projection, status: 'active' });
    for (const body of [suspended, active])
      for (const field of [
        'branding',
        'support',
        'supportEmail',
        'supportUrl',
        'defaultIdentityId',
      ])
        expect(body).not.toHaveProperty(field);
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
    await join(org.id);
    const res = await tenantCall('PUT', `/${org.id}/branding/icon`, {
      x3: b64(makePng(100, 100)),
    });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { code: string; detail: string };
    expect(problem.code).toBe('IMAGE_SIZE');
    expect(problem.detail).toContain('114 × 114 px');
  });

  it('stores @3x and @2x, records the image and keeps it across updates', async () => {
    const org = await makeOrg(fixtures(appEnv));
    await join(org.id);
    const res = await tenantCall('PUT', `/${org.id}/branding/icon`, {
      x3: b64(makePng(114, 114)),
      x2: b64(makePng(76, 76)),
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { branding: { icon?: { w: number; h: number } } };
    expect(saved.branding.icon).toMatchObject({ w: 114, h: 114 });
    const logo = await tenantCall('PUT', `/${org.id}/branding/logo`, {
      x3: b64(makePng(480, 150)),
      x2: b64(makePng(320, 100)),
    });
    expect(logo.status).toBe(200);
    for (const slot of ['icon', 'logo'] as const) {
      for (const scale of [2, 3] as const) {
        const image = await tenantCall('GET', `/${org.id}/branding/${slot}/${scale}x`);
        expect(image.status).toBe(200);
        expect(image.headers.get('content-type')).toBe('image/png');
      }
    }
    const patched = await tenantCall('PATCH', `/${org.id}`, {
      branding: {
        accent: '#0f766e',
        passColors: { background: '#0f172a', foreground: '#ffffff', label: '#94a3b8' },
      },
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { branding: Record<string, unknown> };
    expect(body.branding.icon).toBeDefined();
    expect(body.branding.passColors).toMatchObject({ background: '#0f172a' });
    expect(await actionsOf(org.id)).toContain('org.update');
    const png = await tenantCall('GET', `/${org.id}/branding/icon/2x`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    const removed = await tenantCall('DELETE', `/${org.id}/branding/icon`);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { branding: object }).branding).not.toHaveProperty('icon');
  });

  it('keeps only the @3x when no @2x can be made', async () => {
    const org = await makeOrg(fixtures(appEnv));
    await join(org.id);
    const ctx = createServiceContext(appEnv, { clock });
    await putBrandingImage(
      ctx,
      { type: 'system', id: null },
      org.id,
      'logo',
      { x3: b64(makePng(300, 90)) },
      { resize: async () => null },
    );
    const x3 = await tenantCall('GET', `/${org.id}/branding/logo/3x`);
    expect(x3.status).toBe(200);
    expect(x3.headers.get('content-type')).toBe('image/png');
    expect((await tenantCall('GET', `/${org.id}/branding/logo/2x`)).status).toBe(404);
  });

  it('reads legacy keys and collects superseded objects after each commit', async () => {
    const org = await makeOrg(f);
    await join(org.id);
    const legacy3 = makePng(300, 90);
    const legacy2 = makePng(200, 60);
    const legacy = { sha: await sha256Hex(legacy3), w: 300, h: 90 };
    await appEnv.BUCKET.put(brandingKey(org.id, 'logo', 3), legacy3);
    await appEnv.BUCKET.put(brandingKey(org.id, 'logo', 2), legacy2);
    await run(appEnv.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({ logo: legacy }),
      org.id,
    ]);

    const legacySnapshot = readBranding(await storedBranding(org.id));
    const legacyFiles = await brandingFiles(appEnv.BUCKET, org.id, legacySnapshot.images);
    expect(legacyFiles.map((file) => file.r2Key)).toEqual([
      brandingKey(org.id, 'logo', 3),
      brandingKey(org.id, 'logo', 2),
    ]);
    expect(legacyFiles.every((file) => file.version === legacy.sha)).toBe(true);
    const legacyResponse = await tenantCall('GET', `/${org.id}/branding/logo/3x`);
    expect(legacyResponse.status).toBe(200);
    expect(new Uint8Array(await legacyResponse.arrayBuffer())).toEqual(legacy3);
    const legacySmallResponse = await tenantCall('GET', `/${org.id}/branding/logo/2x`);
    expect(legacySmallResponse.status).toBe(200);
    expect(new Uint8Array(await legacySmallResponse.arrayBuffer())).toEqual(legacy2);

    const x3 = makePng(330, 90);
    const x2 = makePng(220, 60);
    const upload = await tenantCall('PUT', `/${org.id}/branding/logo`, {
      x3: b64(x3),
      x2: b64(x2),
    });
    expect(upload.status).toBe(200);
    expect(await upload.text()).not.toContain('storageVersion');
    const snapshot = readBranding(await storedBranding(org.id));
    const files = await brandingFiles(appEnv.BUCKET, org.id, snapshot.images);
    expect(files.map((file) => file.name)).toEqual(['logo@3x.png', 'logo@2x.png']);
    expect(files[0]?.r2Key).toContain(`orgs/${org.id}/branding/versions/`);
    expect(files[0]?.version).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0]?.version).not.toBe(await sha256Hex(x3));

    // Same @3x digest with different @2x bytes must still create a new cache version.
    const replacement2 = makePng(219, 60);
    const replacement = await tenantCall('PUT', `/${org.id}/branding/logo`, {
      x3: b64(x3),
      x2: b64(replacement2),
    });
    expect(replacement.status).toBe(200);
    const replacementFiles = await brandingFiles(
      appEnv.BUCKET,
      org.id,
      readBranding(await storedBranding(org.id)).images,
    );
    expect(replacementFiles[0]?.version).not.toBe(files[0]?.version);
    const current2 = await tenantCall('GET', `/${org.id}/branding/logo/2x`);
    expect(current2.status).toBe(200);
    expect(new Uint8Array(await current2.arrayBuffer())).toEqual(replacement2);

    // A new @3x-only reference must not fall back to either older @2x object.
    await putBrandingImage(
      createServiceContext(appEnv, { clock }),
      { type: 'system', id: null },
      org.id,
      'logo',
      { x3: b64(x3) },
      { resize: async () => null },
    );
    expect((await tenantCall('GET', `/${org.id}/branding/logo/2x`)).status).toBe(404);
    expect((await tenantCall('DELETE', `/${org.id}/branding/logo`)).status).toBe(200);
    expect((await tenantCall('GET', `/${org.id}/branding/logo/3x`)).status).toBe(404);
    // Superseded objects outlive the commit by the grace period, then none is left.
    for (const file of [...legacyFiles, ...files, ...replacementFiles])
      expect(await appEnv.BUCKET.head(file.r2Key)).not.toBeNull();
    // A separate clock: moving the shared one would expire the test sessions.
    const later = new ManualClock(clock.now() + BRANDING_GC_GRACE_MS);
    await sweepBrandingGc(createServiceContext(appEnv, { clock: later }));
    for (const file of [...legacyFiles, ...files, ...replacementFiles])
      expect(await appEnv.BUCKET.head(file.r2Key)).toBeNull();
    expect((await appEnv.BUCKET.list({ prefix: `orgs/${org.id}/branding/` })).objects).toHaveLength(
      0,
    );
  });

  it('keeps the current objects and the update when collecting the old ones fails', async () => {
    const org = await makeOrg(f);
    await join(org.id);
    const put = (x3: Uint8Array) => tenantCall('PUT', `/${org.id}/branding/logo`, { x3: b64(x3) });
    expect((await put(makePng(300, 90))).status).toBe(200);
    const before = await appEnv.BUCKET.list({ prefix: `orgs/${org.id}/branding/` });
    const failing = new Proxy(appEnv.BUCKET, {
      get(target, prop) {
        if (prop === 'delete') return async () => Promise.reject(new Error('R2 down'));
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = createServiceContext({ ...appEnv, BUCKET: failing }, { clock });
    await putBrandingImage(
      ctx,
      { type: 'system', id: null },
      org.id,
      'logo',
      { x3: b64(makePng(330, 90)) },
      { resize: async () => null },
    );
    const after = await appEnv.BUCKET.list({ prefix: `orgs/${org.id}/branding/` });
    expect(after.objects.length).toBeGreaterThan(before.objects.length);
    const files = await brandingFiles(
      appEnv.BUCKET,
      org.id,
      readBranding(await storedBranding(org.id)).images,
    );
    expect(files.length).toBeGreaterThan(0);
  });

  it('removes staged objects when an upload fails before its org commit', async () => {
    const org = await makeOrg(f);
    await join(org.id);
    let puts = 0;
    const bucket = new Proxy(appEnv.BUCKET, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'put')
          return async (...args: unknown[]) => {
            puts += 1;
            if (puts === 2) throw new Error('R2 put failed');
            return value.apply(target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      putBrandingImage(
        createServiceContext({ ...appEnv, BUCKET: bucket }, { clock }),
        { type: 'system', id: null },
        org.id,
        'logo',
        { x3: b64(makePng(300, 90)), x2: b64(makePng(200, 60)) },
      ),
    ).rejects.toThrow('R2 put failed');
    expect(await storedBranding(org.id)).not.toHaveProperty('logo');
    expect((await appEnv.BUCKET.list({ prefix: `orgs/${org.id}/branding/` })).objects).toHaveLength(
      0,
    );
  });

  it('rejects a stale tenant commit and removes only its staged objects', async () => {
    const org = await makeOrg(f);
    await join(org.id);
    expect(
      (
        await tenantCall('PUT', `/${org.id}/branding/logo`, {
          x3: b64(makePng(300, 90)),
          x2: b64(makePng(200, 60)),
        })
      ).status,
    ).toBe(200);
    const before = await storedBranding(org.id);
    const audit = await actionsOf(org.id);
    const prefix = `orgs/${org.id}/branding/`;
    const keys = (await appEnv.BUCKET.list({ prefix })).objects.map((object) => object.key).sort();
    let intervened = false;
    const bucket = new Proxy(appEnv.BUCKET, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'put')
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            if (!intervened && String(args[0]).endsWith('/logo@2x.png')) {
              intervened = true;
              await run(
                appEnv.DB,
                'UPDATE orgs SET branding = ?, updated_at = updated_at + 1 WHERE id = ?',
                [JSON.stringify({ ...before, accent: '#123456' }), org.id],
              );
            }
            return result;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await app.request(
      `/api/v1/orgs/${org.id}/branding/logo`,
      {
        method: 'PUT',
        headers: { ...orgAdmin.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ x3: b64(makePng(330, 90)), x2: b64(makePng(220, 60)) }),
      },
      { ...appEnv, BUCKET: bucket },
    );
    expect(intervened).toBe(true);
    // The concurrent branding save moved config_revision: a 409 to refetch, with the staged objects removed.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SETTINGS_CHANGED' });
    expect(await storedBranding(org.id)).toEqual({ ...before, accent: '#123456' });
    expect(await actionsOf(org.id)).toEqual(audit);
    expect(
      (await appEnv.BUCKET.list({ prefix })).objects.map((object) => object.key).sort(),
    ).toEqual(keys);
  });

  it('does not remove an image using a tenant authority captured before an org suspension', async () => {
    const org = await makeOrg(f);
    await join(org.id);
    expect(
      (
        await tenantCall('PUT', `/${org.id}/branding/logo`, {
          x3: b64(makePng(300, 90)),
          x2: b64(makePng(200, 60)),
        })
      ).status,
    ).toBe(200);
    const before = await storedBranding(org.id);
    const audit = await actionsOf(org.id);
    const prefix = `orgs/${org.id}/branding/`;
    const keys = (await appEnv.BUCKET.list({ prefix })).objects.map((object) => object.key).sort();
    const ctx = createServiceContext(appEnv, { clock });
    const session = await createSessionStore(appEnv, clock).resolve(orgAdmin.cookieValue);
    if (!session) throw new Error('Organization administrator session is missing.');
    const authority = await tenantAuthorityOf(ctx, session, org.id, 'org:manage');
    if (authority.kind !== 'session') throw new Error('Expected session authority.');
    // Suspending and reactivating moves access_revision: the captured authority no longer holds.
    await run(appEnv.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    await run(appEnv.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [org.id]);
    await expect(
      deleteBrandingImage(ctx, { type: 'user', id: orgAdmin.userId }, org.id, 'logo', authority),
    ).rejects.toMatchObject({ status: 403, code: 'ORG_ACCESS_CHANGED' });
    expect(await storedBranding(org.id)).toEqual(before);
    expect(await actionsOf(org.id)).toEqual(audit);
    expect(
      (await appEnv.BUCKET.list({ prefix })).objects.map((object) => object.key).sort(),
    ).toEqual(keys);
    expect((await tenantCall('GET', `/${org.id}/branding/logo/3x`)).status).toBe(200);
  });

  it('removes an image after the org timestamp moved, which is not authority', async () => {
    const org = await makeOrg(f);
    await join(org.id);
    expect(
      (
        await tenantCall('PUT', `/${org.id}/branding/logo`, {
          x3: b64(makePng(300, 90)),
          x2: b64(makePng(200, 60)),
        })
      ).status,
    ).toBe(200);
    const ctx = createServiceContext(appEnv, { clock });
    const session = await createSessionStore(appEnv, clock).resolve(orgAdmin.cookieValue);
    if (!session) throw new Error('Organization administrator session is missing.');
    const authority = await tenantAuthorityOf(ctx, session, org.id, 'org:manage');
    if (authority.kind !== 'session') throw new Error('Expected session authority.');
    await run(appEnv.DB, 'UPDATE orgs SET updated_at = updated_at + 1 WHERE id = ?', [org.id]);
    await deleteBrandingImage(
      ctx,
      { type: 'user', id: orgAdmin.userId },
      org.id,
      'logo',
      authority,
    );
    expect(await storedBranding(org.id)).not.toHaveProperty('logo');
  });

  it('keeps committed objects when a later audit write fails', async () => {
    const org = await makeOrg(f);
    const db = new Proxy(appEnv.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            if (sql.includes('INSERT INTO audit_log')) throw new Error('Audit write failed');
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      putBrandingImage(
        createServiceContext({ ...appEnv, DB: db }, { clock }),
        { type: 'system', id: null },
        org.id,
        'logo',
        { x3: b64(makePng(300, 90)), x2: b64(makePng(200, 60)) },
      ),
    ).rejects.toThrow('Audit write failed');
    const images = readBranding(await storedBranding(org.id)).images;
    const files = await brandingFiles(appEnv.BUCKET, org.id, images);
    expect(files.map((file) => file.name)).toEqual(['logo@3x.png', 'logo@2x.png']);
    expect((await appEnv.BUCKET.list({ prefix: `orgs/${org.id}/branding/` })).objects).toHaveLength(
      2,
    );
  });

  it('retains staged objects when the org commit result is ambiguous', async () => {
    const org = await makeOrg(f);
    const db = new Proxy(appEnv.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('UPDATE orgs SET branding =')) return statement;
            return {
              bind: (...args: unknown[]) => {
                const bound = statement.bind(...args);
                return {
                  first: async () => {
                    await bound.first();
                    throw new Error('D1 response lost');
                  },
                };
              },
            };
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      putBrandingImage(
        createServiceContext({ ...appEnv, DB: db }, { clock }),
        { type: 'system', id: null },
        org.id,
        'logo',
        { x3: b64(makePng(300, 90)), x2: b64(makePng(200, 60)) },
      ),
    ).rejects.toThrow('D1 response lost');
    const images = readBranding(await storedBranding(org.id)).images;
    expect(images).toHaveLength(1);
    const files = await brandingFiles(appEnv.BUCKET, org.id, images);
    expect(files.map((file) => file.name)).toEqual(['logo@3x.png', 'logo@2x.png']);
    expect((await appEnv.BUCKET.list({ prefix: `orgs/${org.id}/branding/` })).objects).toHaveLength(
      2,
    );
  });
});

describe('email preview', () => {
  it('renders the real pass email with the org name, uploaded images and the buddy choice', async () => {
    const org = await makeOrg(fixtures(appEnv), { name: 'Zed Climbing' });
    await join(org.id);
    expect(
      (await tenantCall('PUT', `/${org.id}/branding/icon`, { x3: b64(makePng(114, 114)) })).status,
    ).toBe(200);
    const res = await tenantCall('GET', `/${org.id}/email-preview?buddy=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).not.toContain('script-src');
    const html = await res.text();
    expect(html).toContain('Zed Climbing');
    expect(html).toContain(`/api/v1/orgs/${org.id}/branding/icon/3x`);
    expect(html).not.toContain('/branding/logo/3x');
    expect(html).toContain('/email/buddy-');
    const plain = await (await tenantCall('GET', `/${org.id}/email-preview?buddy=0`)).text();
    expect(plain).not.toContain('/email/buddy-');
    expect((await tenantCall('GET', '/missing/email-preview')).status).toBe(403);
  });
});
