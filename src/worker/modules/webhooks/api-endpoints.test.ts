import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeTemplate, persistTemplate } from '../../../../test/helpers/index.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import {
  type Api,
  auditOf,
  BASE,
  GOOD,
  rowCount,
  secretRows,
  setupApi,
  wipe,
} from './api-test-fixtures.ts';
import { type Net, stubNet } from './deliver-test-fixtures.ts';
import { activeSecrets } from './repo-secrets.ts';
import { clearResolverMemo } from './resolver-memo.ts';
import { openSecret } from './secrets.ts';
import { seedEndpoint } from './webhooks-test-fixtures.ts';

let api: Api;
let net: Net;
let orgId: string;
let admin: Record<string, string>;

beforeAll(async () => {
  api = await setupApi();
  net = stubNet();
  orgId = api.rig.orgId;
});
afterAll(() => net.restore());
beforeEach(async () => {
  await wipe(api.rig);
  admin = await api.member(['org_admin']);
  net.calls.length = 0;
  net.dns = {};
  clearResolverMemo();
  api.resetLimits();
});

const create = (extra: Record<string, unknown> = {}) =>
  api.call('POST', BASE, { orgId, ...GOOD, ...extra }, admin);

/** The secrets of an endpoint, opened. */
async function openAll(endpointId: string) {
  const ring = await loadKekRing(api.rig.kit.env);
  const rows = await activeSecrets(
    api.rig.db,
    { orgId, mode: 'live' },
    endpointId,
    api.rig.kit.clock.now(),
  );
  return Promise.all(
    rows.map((r) =>
      openSecret(ring, r.envelope, { secretId: r.id, orgId, endpointId, mode: 'live' }),
    ),
  );
}

describe('create, read, update, delete', () => {
  it('creates an endpoint with its secret and returns the secret once', async () => {
    const res = await create({ description: 'Door', mode: 'test', orgId });
    expect(res.status).toBe(201);
    const { endpoint, secret } = res.json;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{32,}$/);
    expect(endpoint).toMatchObject({
      orgId,
      mode: 'live',
      url: GOOD.url,
      description: 'Door',
      eventTypes: GOOD.eventTypes,
      templateIds: null,
      apiVersion: '2026-11-20',
      status: 'active',
    });
    expect(await openAll(endpoint.id)).toEqual([secret]);
    // The secret is stored sealed and never read back.
    const [row] = await secretRows(api.rig.db, endpoint.id);
    expect(JSON.stringify(row)).not.toContain(secret);
    for (const path of [
      `${BASE}/${endpoint.id}`,
      `${BASE}?orgId=${orgId}`,
      `${BASE}/${endpoint.id}/deliveries`,
    ]) {
      expect((await api.call('GET', path, undefined, admin)).text).not.toContain(secret);
    }
  });

  it('ignores a mode in the body: the authority decides', async () => {
    const test = await api.member(['org_admin'], { mode: 'test' });
    const res = await api.call('POST', BASE, { orgId, ...GOOD, mode: 'live' }, test);
    expect(res.json.endpoint.mode).toBe('test');
  });

  it('with ?validate=1 checks everything and writes nothing', async () => {
    const ok = await api.call('POST', `${BASE}?validate=1`, { orgId, ...GOOD }, admin);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true });
    expect(await rowCount(api.rig.db, 'webhook_endpoints')).toBe(0);
    expect(await rowCount(api.rig.db, 'webhook_endpoint_secrets')).toBe(0);
    expect(await auditOf(api.rig.db, 'webhook.endpoint.create')).toEqual([]);
    const bad = await api.call(
      'POST',
      `${BASE}?validate=1`,
      { orgId, ...GOOD, url: 'http://hooks.example.com/x' },
      admin,
    );
    await expectProblem(bad, 422, 'UNSAFE_URL');
  });

  it('refuses unsafe URLs', async () => {
    net.dns['private.example.com'] = ['10.0.0.5'];
    net.dns['empty.example.com'] = [];
    const urls = [
      'http://hooks.example.com/x',
      'https://hooks.example.com:8443/x',
      'https://user:pw@hooks.example.com/x',
      'https://93.184.216.34/x',
      'https://localhost/x',
      'https://hooks.example.com./x',
      'https://private.example.com/x',
      'https://empty.example.com/x',
      'https://app.workers.dev/x',
    ];
    for (const url of urls) {
      const res = await create({ url });
      expect(res.status, url).toBeGreaterThanOrEqual(400);
      expect(res.json.code ?? res.json.error?.code, url).toBe('UNSAFE_URL');
    }
    expect(await rowCount(api.rig.db, 'webhook_endpoints')).toBe(0);
  });

  it('accepts the organization own templates only', async () => {
    const own = makeTemplate({ id: `tpl-own-${orgId.slice(-6)}`, orgId });
    await persistTemplate(api.rig.kit.fx, own.resolved, { registry: own.registry });
    const ok = await create({ templateIds: [own.resolved.id] });
    expect(ok.status).toBe(201);
    expect(ok.json.endpoint.templateIds).toEqual([own.resolved.id]);
    const other = await api.otherOrg();
    const theirs = makeTemplate({ id: `tpl-theirs-${other.slice(-6)}`, orgId: other });
    await persistTemplate(api.rig.kit.fx, theirs.resolved, { registry: theirs.registry });
    const res = await create({ templateIds: [theirs.resolved.id] });
    await expectProblem(res, 422, 'UNKNOWN_TEMPLATE');
    expect((await create({ templateIds: [own.resolved.id, 'nope'] })).status).toBe(422);
    expect(await rowCount(api.rig.db, 'webhook_endpoints')).toBe(1);
  });

  it('validates the body: types come from the catalog, no wildcard, no test event', async () => {
    for (const eventTypes of [[], ['*'], ['webhook.test'], ['pass.nope']])
      expect((await create({ eventTypes })).status).toBe(422);
    expect((await create({ url: '' })).status).toBe(422);
  });

  it('stops at the platform ceiling of 100 endpoints per mode with a stable code', async () => {
    for (let i = 0; i < 100; i++) await seedEndpoint(api.rig.db, { orgId });
    await expectProblem(
      await create({ url: 'https://hooks.example.com/101' }),
      409,
      'WEBHOOK_ENDPOINT_LIMIT',
    );
    expect(await rowCount(api.rig.db, 'webhook_endpoints')).toBe(100);
    const test = await api.member(['org_admin'], { mode: 'test' });
    expect((await api.call('POST', BASE, { orgId, ...GOOD }, test)).status).toBe(201);
  });

  it('updates, pauses and resumes, and re-checks a new URL', async () => {
    const id = (await create()).json.endpoint.id as string;
    const patched = await api.call(
      'PATCH',
      `${BASE}/${id}`,
      {
        description: 'Gate',
        eventTypes: ['pass.voided'],
        url: 'https://hooks.example.com/new/zzzz',
      },
      admin,
    );
    expect(patched.json).toMatchObject({
      description: 'Gate',
      eventTypes: ['pass.voided'],
      url: 'https://hooks.example.com/new/zzzz',
    });
    expect(
      (await api.call('PATCH', `${BASE}/${id}`, { status: 'paused' }, admin)).json.status,
    ).toBe('paused');
    expect(
      (await api.call('PATCH', `${BASE}/${id}`, { status: 'active' }, admin)).json.status,
    ).toBe('active');
    expect(
      (await api.call('PATCH', `${BASE}/${id}`, { description: '' }, admin)).json.description,
    ).toBe('');
    await expectProblem(
      await api.call('PATCH', `${BASE}/${id}`, { url: 'http://x.example.com/' }, admin),
      422,
      'UNSAFE_URL',
    );
    expect((await api.call('PATCH', `${BASE}/${id}`, { status: 'disabled' }, admin)).status).toBe(
      422,
    );
    expect(
      (await api.call('PATCH', `${BASE}/${id}`, { orgId: 'x', mode: 'test' }, admin)).json.mode,
    ).toBe('live');
  });

  it('deletes an endpoint with its secrets, and a second delete is a 404', async () => {
    const id = (await create()).json.endpoint.id as string;
    expect((await api.call('DELETE', `${BASE}/${id}`, undefined, admin)).json).toEqual({
      ok: true,
    });
    expect(await rowCount(api.rig.db, 'webhook_endpoint_secrets', 'endpoint_id = ?', [id])).toBe(0);
    expect((await api.call('GET', `${BASE}/${id}`, undefined, admin)).status).toBe(404);
    expect((await api.call('DELETE', `${BASE}/${id}`, undefined, admin)).status).toBe(404);
    expect((await api.call('POST', `${BASE}/${id}/secret`, {}, admin)).status).toBe(404);
    expect(await rowCount(api.rig.db, 'webhook_endpoint_secrets')).toBe(0);
  });

  it('audits create, update, delete with the host and never the path or a secret', async () => {
    const { endpoint, secret } = (await create()).json;
    await api.call(
      'PATCH',
      `${BASE}/${endpoint.id}`,
      { url: 'https://hooks.example.com/new/zzzz' },
      admin,
    );
    await api.call('POST', `${BASE}/${endpoint.id}/secret`, {}, admin);
    await api.call('DELETE', `${BASE}/${endpoint.id}`, undefined, admin);
    for (const action of ['create', 'update', 'delete']) {
      const [row] = await auditOf(api.rig.db, `webhook.endpoint.${action}`);
      expect(row, action).toMatchObject({
        org_id: orgId,
        actor_type: 'user',
        target_id: endpoint.id,
      });
      expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({
        host: 'hooks.example.com',
        endpointId: endpoint.id,
      });
    }
    const all = JSON.stringify([
      ...(await auditOf(api.rig.db, 'webhook.endpoint.create')),
      ...(await auditOf(api.rig.db, 'webhook.endpoint.update')),
      ...(await auditOf(api.rig.db, 'webhook.endpoint.delete')),
      ...(await auditOf(api.rig.db, 'webhook.secret.rotate')),
    ]);
    expect(all).not.toContain('abc123');
    expect(all).not.toContain('zzzz');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('whsec_');
  });
});

describe('secrets', () => {
  it('rotate returns a new secret once, and the old one signs through the overlap', async () => {
    const { endpoint, secret: first } = (await create()).json;
    const res = await api.call(
      'POST',
      `${BASE}/${endpoint.id}/secret`,
      { overlapHours: 24 },
      admin,
    );
    expect(res.status).toBe(200);
    const second = res.json.secret as string;
    expect(second).toMatch(/^whsec_/);
    expect(second).not.toBe(first);
    expect(await openAll(endpoint.id)).toHaveLength(2);
    expect(await openAll(endpoint.id)).toEqual(expect.arrayContaining([second, first]));
    const rows = await secretRows(api.rig.db, endpoint.id);
    expect(rows.filter((r) => r.expires_at === null)).toHaveLength(1);
    expect(rows.find((r) => r.expires_at !== null)?.expires_at).toBe(
      api.rig.kit.clock.now() + 24 * 3_600_000,
    );
    expect((await api.call('GET', `${BASE}/${endpoint.id}`, undefined, admin)).text).not.toContain(
      second,
    );
    // After the overlap the old secret is gone.
    api.rig.kit.clock.advance(25 * 3_600_000);
    expect(await openAll(endpoint.id)).toEqual([second]);
  });

  it('cuts an older expiring secret when rotated twice, and 0 hours drops the old one at once', async () => {
    const { endpoint, secret: s1 } = (await create()).json;
    const s2 = (
      await api.call('POST', `${BASE}/${endpoint.id}/secret`, { overlapHours: 72 }, admin)
    ).json.secret;
    const s3 = (
      await api.call('POST', `${BASE}/${endpoint.id}/secret`, { overlapHours: 24 }, admin)
    ).json.secret;
    // s1 was still inside its overlap: it is cut to now. s2 overlaps with s3.
    expect(await openAll(endpoint.id)).toEqual(expect.arrayContaining([s3, s2]));
    expect(await openAll(endpoint.id)).toHaveLength(2);
    expect(await openAll(endpoint.id)).not.toContain(s1);
    const s4 = (await api.call('POST', `${BASE}/${endpoint.id}/secret`, { overlapHours: 0 }, admin))
      .json.secret;
    expect(await openAll(endpoint.id)).toEqual([s4]);
    expect(await auditOf(api.rig.db, 'webhook.secret.rotate')).toHaveLength(3);
  });

  it('rotates with each overlap choice: 0, 1, 24, 72 and 168 hours', async () => {
    const id = (await create()).json.endpoint.id as string;
    for (const overlapHours of [0, 1, 24, 72, 168])
      expect((await api.call('POST', `${BASE}/${id}/secret`, { overlapHours }, admin)).status).toBe(
        200,
      );
  });

  it('refuses any other overlap', async () => {
    const id = (await create()).json.endpoint.id as string;
    for (const overlapHours of [2, -1, 100, 169, '24'])
      expect((await api.call('POST', `${BASE}/${id}/secret`, { overlapHours }, admin)).status).toBe(
        422,
      );
    expect((await api.call('POST', `${BASE}/${id}/secret`, {}, admin)).status).toBe(200);
    expect(await rowCount(api.rig.db, 'webhook_endpoint_secrets', 'endpoint_id = ?', [id])).toBe(2);
  });

  it('a refused rotation stores nothing and audits nothing', async () => {
    const other = await api.member(['org_admin'], { orgId: await api.otherOrg() });
    const id = (await create()).json.endpoint.id as string;
    const before = await rowCount(api.rig.db, 'webhook_endpoint_secrets');
    expect((await api.call('POST', `${BASE}/${id}/secret`, {}, other)).status).toBe(404);
    expect(await rowCount(api.rig.db, 'webhook_endpoint_secrets')).toBe(before);
    expect(await auditOf(api.rig.db, 'webhook.secret.rotate')).toEqual([]);
    expect(await first(api.rig.db, 'SELECT 1 FROM authority_grants LIMIT 1')).toBeNull();
  });
});

describe('lastStatus', () => {
  it('is the HTTP status of the newest attempted delivery, in the list and on the endpoint', async () => {
    const made = await create();
    const id = made.json.endpoint.id as string;
    expect(made.json.endpoint.lastStatus).toBeNull();
    await api.rig.kit.pass({ orgId });
    await api.rig.kit.pass({ orgId });
    await run(
      api.rig.db,
      `UPDATE webhook_deliveries SET last_status = CASE event_seq WHEN (SELECT min(event_seq) FROM webhook_deliveries WHERE endpoint_id = ?1) THEN 200 ELSE 503 END,
         last_attempt_at = 1 WHERE endpoint_id = ?1`,
      [id],
    );
    expect(
      ((await api.call('GET', `${BASE}/${id}`, undefined, admin)).json as { lastStatus: number })
        .lastStatus,
    ).toBe(503);
    const list = await api.call('GET', `${BASE}?orgId=${orgId}`, undefined, admin);
    expect(list.json.items[0].lastStatus).toBe(503);
  });
});
