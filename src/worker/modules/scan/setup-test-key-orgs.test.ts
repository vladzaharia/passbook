import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { newKey } from './setup-intent-test-fixtures.ts';

const fixture = scanningSessionsFixture();
let app: ReturnType<typeof createApp>;
let sandboxId: string;
beforeAll(async () => {
  await fixture.setup();
  const { kit } = fixture;
  app = createApp({
    stores: {
      ...fixture.fake.stores,
      apiKeys: createApiKeyStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  sandboxId = (await makeOrg(kit.fx, { kind: 'developer' })).id;
  await run(
    kit.env.DB,
    "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'scanning.devices', '1', 1)",
    [sandboxId],
  );
});

const scanTpl = (orgId: string) =>
  fixture.kit.scanTemplate(
    `Tpl ${orgId.slice(-6)}`,
    { actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }] },
    { orgId, releaseModes: ['test'] },
  );
const testKey = (orgId: string) =>
  makeApiKey(fixture.kit.fx, { orgId, scopes: ['scanning:write'], mode: 'test' });
const post = (path: string, headers: Record<string, string>, body: unknown, key = newKey()) =>
  app.request(
    `https://wallet.test/api/v1${path}`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    },
    fixture.kit.env,
  );

describe('scanners setup with a place, by a Test key', () => {
  const body = (orgId: string, templateId: string) => ({
    orgId,
    doors: [{ name: 'Door', admits: { templateIds: [templateId] } }],
    places: [{ ref: 'z', name: `Place ${orgId.slice(-6)}` }],
  });

  it('is refused in an organization', async () => {
    const k = await testKey(fixture.kit.org.id);
    const t = await scanTpl(fixture.kit.org.id);
    await expectProblem(
      await post('/scanning-sessions/setup', k.headers, body(fixture.kit.org.id, t)),
      403,
      'MODE_LIVE_REQUIRED',
    );
  });

  it('is allowed in a sandbox', async () => {
    const k = await testKey(sandboxId);
    const t = await scanTpl(sandboxId);
    const res = await post('/scanning-sessions/setup', k.headers, body(sandboxId, t));
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe('template scan setup, by a Test key', () => {
  it('works in an organization and in a sandbox', async () => {
    for (const orgId of [fixture.kit.org.id, sandboxId]) {
      const id = await scanTpl(orgId);
      const k = await testKey(orgId);
      const res = await post(`/templates/${id}/scan-setup`, k.headers, { orgId, timeZone: 'UTC' });
      expect(res.status, await res.clone().text()).toBe(200);
    }
  });
});
