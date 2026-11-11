import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { PassDetailSchema, PassListSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

type Headers = Record<string, string>;
let auth: TenantTestAuth;
let kit: Kit;
let app: ReturnType<typeof createApp>;
let release: TemplateRelease;
let strangerOrg: { id: string };
let orgKey: Headers;

const api = (path: string, init: RequestInit = {}) =>
  app.request(`https://wallet.test/api/v1${path}`, init, kit.env);
const post = (headers: Headers, body: unknown) =>
  api('/passes', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  kit = await setupKit();
  strangerOrg = await makeOrg(kit.fx, { name: 'No Membership' });
  const active = await activeRelease(kit.ctx, kit.template.id, kit.org.id, 'live', 'apple');
  if (!active) throw new Error('Default Live release missing');
  release = active;
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  orgKey = await auth.apiKey({
    orgId: kit.org.id,
    scopes: ['passes:read', 'passes:write', 'holders:write'],
  });
}, 60_000);

describe('/api/v1 baseline request shapes (8f5bee02)', () => {
  it('creates with orgId, templateId and input only, fencing the effective release', async () => {
    const res = await post(orgKey, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      input: { memberName: 'Baseline' },
    });
    expect(res.status).toBe(201);
    const body = PassDetailSchema.parse(await res.json());
    expect(await getPass(kit.env.DB, body.id)).toMatchObject({
      orgId: kit.org.id,
      templateVersion: release.version,
      releaseId: release.id,
    });
  });

  it('defaults orgId to the key organization on create and on every list', async () => {
    const res = await post(orgKey, {
      templateId: kit.template.id,
      input: { memberName: 'No Org' },
    });
    expect(res.status).toBe(201);
    const passes = PassListSchema.parse(await (await api('/passes', { headers: orgKey })).json());
    expect(passes.items.length).toBeGreaterThan(0);
    expect(passes.items.every((p) => p.orgId === kit.org.id)).toBe(true);
    expect((await api('/holders', { headers: orgKey })).status).toBe(200);
    expect((await api('/bundles', { headers: orgKey })).status).toBe(200);
  });

  it('still refuses a foreign orgId and a global key without orgId on holders and bundles', async () => {
    expect(
      (await post(orgKey, { orgId: strangerOrg.id, templateId: kit.template.id, input: {} }))
        .status,
    ).toBe(403);
    expect((await api(`/passes?orgId=${strangerOrg.id}`, { headers: orgKey })).status).toBe(403);
    const global = await auth.apiKey({ orgId: null, scopes: ['passes:read'] });
    expect((await api('/holders', { headers: global })).status).toBe(422);
    expect((await api('/bundles', { headers: global })).status).toBe(422);
  });
});

describe('session callers stay strict', () => {
  it('requires the reviewed mode and release fields', async () => {
    const res = await post(auth.admin(), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      input: { memberName: 'Strict' },
    });
    expect(res.status).toBe(422);
  });

  it('answers 403, not an empty page, for an organization without membership', async () => {
    expect((await api(`/passes?orgId=${strangerOrg.id}`, { headers: auth.admin() })).status).toBe(
      403,
    );
    expect((await api('/passes', { headers: auth.admin() })).status).toBe(422);
  });
});
