import { beforeAll, describe, expect, it } from 'vitest';
import {
  deviceToken,
  makeOrg,
  makePass,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createBundle } from '../bundles/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';

/**
 * The file routes a developer org's holders could reach, over HTTP: each answers 409 SANDBOX_PREVIEW_ONLY (or
 * offers nothing to package) for a developer org's pass, and serves a standard org's pass as before.
 */
const ORIGIN = 'https://passbook.mobile';
const TYPE = 'pass.im.plrs.wallet';
let kit: Kit;
let app: ReturnType<typeof createApp>;
let dev: { id: string };
let std: { id: string };

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
  dev = await makeOrg(kit.fx, { kind: 'developer' });
  std = await makeOrg(kit.fx);
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers }, kit.env);

async function bundleOf(orgId: string) {
  const to = `holder-${kit.fx.ids.token(4).toLowerCase()}@example.com`;
  const passes = [
    await kit.pass({ orgId, mode: 'test', holderEmail: to }),
    await kit.pass({ orgId, mode: 'test', holderEmail: to }),
  ];
  const bundle = await createBundle(
    jobCtxOf(kit),
    { type: 'system', id: null },
    'test',
    { orgId, passIds: passes.map((p) => p.id), name: 'Bundle', holderEmail: to },
    { kind: 'system' },
  );
  return { passes, token: bundle.url?.split('/b/')[1] ?? '' };
}

describe('bundle routes', () => {
  it('refuse a developer bundle at the archive and at each pass file', async () => {
    const { passes, token } = await bundleOf(dev.id);
    const archive = await get(`/b/${token}/passes.pkpasses`);
    expect(archive.status).toBe(409);
    expect(((await archive.json()) as { code: string }).code).toBe('SANDBOX_PREVIEW_ONLY');
    for (const pass of passes) {
      const file = await get(`/b/${token}/${pass.id}/pass.pkpass`);
      expect(file.status).toBe(409);
      expect(((await file.json()) as { code: string }).code).toBe('SANDBOX_PREVIEW_ONLY');
    }
  });

  it('still serve a standard bundle', async () => {
    const { passes, token } = await bundleOf(std.id);
    const first = passes[0];
    const file = await get(`/b/${token}/${first?.id}/pass.pkpass`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('pkpass');
    await file.arrayBuffer();
  });
});

describe('Apple web service', () => {
  const latest = (pass: { serial: string }, auth: string) =>
    get(`/wallet/v1/passes/${TYPE}/${pass.serial}`, { authorization: `ApplePass ${auth}` });

  it('refuses to hand a developer pass to a device', async () => {
    const pass = await kit.pass({ orgId: dev.id, mode: 'test' });
    const res = await latest(pass, deviceToken(pass));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('SANDBOX_PREVIEW_ONLY');
  });

  it('still hands a standard pass over', async () => {
    const pass = await kit.pass({ orgId: std.id, mode: 'test' });
    const res = await latest(pass, deviceToken(pass));
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });
});

describe('/me add all', () => {
  async function owned(orgId: string) {
    const user = await makeUser(kit.fx);
    await makePass(kit.fx, { orgId, template: kit.template, ownerUserId: user.id, mode: 'test' });
    return { user, headers: (await makeSession(kit.fx, { userId: user.id })).headers };
  }

  it('packages nothing for a developer pass', async () => {
    const { headers } = await owned(dev.id);
    const list = await get('/api/v1/me/passes', headers);
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: { downloadUrl: string | null }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    // No Apple copy is offered, so there is nothing to add.
    for (const item of items) expect(item.downloadUrl).toBeNull();
    const bundle = await get('/api/v1/me/passes.pkpasses?part=1&snapshot=x', headers);
    expect(bundle.status).toBeGreaterThanOrEqual(400);
    expect(bundle.headers.get('content-type') ?? '').not.toContain('pkpasses');
  });

  it('offers a standard pass its Apple copy', async () => {
    const { headers } = await owned(std.id);
    const list = await get('/api/v1/me/passes', headers);
    const items = ((await list.json()) as { items: { downloadUrl: string | null }[] }).items;
    expect(items.some((i) => i.downloadUrl !== null)).toBe(true);
  });
});
