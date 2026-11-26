import { beforeAll, describe, expect, it } from 'vitest';
import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import {
  PassDevicesSchema,
  type SimulatePassResponse,
  SimulatePassResponseSchema,
} from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { recordPassEvent } from '../events/record.ts';
import { eventMember, eventStores } from '../events/test-auth-fixtures.ts';
import { buildEnvelope } from '../webhooks/payload.ts';
import {
  ALL_TYPES,
  deliveriesOf,
  feedOf,
  seedEndpoint,
} from '../webhooks/webhooks-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let app: ReturnType<typeof createApp>;
let testKey: Record<string, string>;
let liveKey: Record<string, string>;
let session: Record<string, string>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: eventStores(kit), clock: kit.clock });
  testKey = (await makeApiKey(kit.fx, { orgId: kit.org.id, mode: 'test' })).headers;
  liveKey = (await makeApiKey(kit.fx, { orgId: kit.org.id, mode: 'live' })).headers;
  const member = await eventMember(kit, kit.org.id, ['org_admin']);
  session = { ...member.session.headers, origin: ORIGIN };
});

const simulate = (passId: string, headers: Record<string, string>, body: object) =>
  app.request(
    `${ORIGIN}/api/v1/passes/${passId}/simulate`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
const send = async (passId: string, body: object, headers = testKey) => {
  const res = await simulate(passId, headers, body);
  expect(res.status).toBe(201);
  return SimulatePassResponseSchema.parse(await res.json());
};
const devices = async (passId: string) =>
  PassDevicesSchema.parse(
    await (
      await app.request(`${ORIGIN}/api/v1/passes/${passId}/devices`, { headers: testKey }, kit.env)
    ).json(),
  ).devices;

describe('simulate', () => {
  it('refuses a Live pass for a session and a key (L7, server side)', async () => {
    const pass = await kit.pass();
    for (const headers of [liveKey, session]) {
      const res = await simulate(pass.id, headers, { event: 'installed' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('SIMULATE_TEST_ONLY');
    }
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM pass_simulated_devices WHERE pass_id = ?', [pass.id]),
    ).toEqual([]);
  });

  it('installs a simulated device that the devices view merges, and uninstalls it by id', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const installed = await send(pass.id, { event: 'installed', platform: 'apple' });
    expect(installed.deviceId).toBeTruthy();
    const [row] = await devices(pass.id);
    expect(row).toMatchObject({ simulated: true, deviceId: installed.deviceId });
    expect(row?.registeredAt).not.toBeNull();

    const other = await send(pass.id, { event: 'installed' });
    expect(await devices(pass.id)).toHaveLength(2);

    const gone = await send(pass.id, { event: 'uninstalled', deviceId: installed.deviceId });
    expect(gone.deviceId).toBeUndefined();
    const after = await devices(pass.id);
    expect(after.find((d) => d.deviceId === installed.deviceId)).toMatchObject({
      status: 'removed',
      registeredAt: null,
    });
    expect(after.find((d) => d.deviceId === other.deviceId)?.registeredAt).not.toBeNull();
    const again = await simulate(pass.id, testKey, {
      event: 'uninstalled',
      deviceId: installed.deviceId,
    });
    expect(again.status).toBe(409);
  });

  it('answers 409 SIMULATE_NO_DEVICE and 404 for a device that is not this pass', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const none = await simulate(pass.id, testKey, { event: 'uninstalled' });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { code: string }).code).toBe('SIMULATE_NO_DEVICE');
    const wrong = await simulate(pass.id, testKey, { event: 'push_failed', deviceId: 'nope' });
    expect(wrong.status).toBe(404);
  });

  it('every event emits a Test webhook that carries the requestId (L7)', async () => {
    const pass = await kit.pass({ mode: 'test', holderEmail: 'holder@example.com' });
    await kit.settle();
    await run(kit.env.DB, 'DELETE FROM captured_emails WHERE pass_id = ?', [pass.id]);
    await run(
      kit.env.DB,
      `INSERT INTO outbox (id, org_id, kind, pass_id, state, error_code, created_at, finished_at)
       VALUES ('out-' || ?1, ?2, 'email', ?1, 'sent', 'TEST_MODE', 1, 1)`,
      [pass.id, kit.org.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO captured_emails (id, org_id, pass_id, outbox_id, recipient, subject, html, text, created_at, intent)
       VALUES ('cap-' || ?1, ?2, ?1, 'out-' || ?1, 'holder@example.com', 's', '', '', 1, '{}')`,
      [pass.id, kit.org.id],
    );
    const endpoint = await seedEndpoint(kit.env.DB, {
      orgId: kit.org.id,
      mode: 'test',
      eventTypes: ALL_TYPES,
    });
    const before = (await feedOf(kit.env.DB, pass.id)).length;

    const results: Record<string, SimulatePassResponse> = {};
    for (const event of [
      'installed',
      'updated_on_device',
      'push_failed',
      'scanned',
      'scan_refused',
      'email_failed',
      'uninstalled',
    ]) {
      results[event] = await send(pass.id, { event });
    }

    const feed = (await feedOf(kit.env.DB, pass.id)).slice(before);
    // updated_on_device is not a webhook type; the other six are.
    expect(feed.map((r) => r.type)).toEqual([
      'pass.installed',
      'push.failed',
      'pass.scanned',
      'pass.scan_refused',
      'email.failed',
      'pass.uninstalled',
    ]);
    for (const row of feed) {
      const envelope = buildEnvelope({
        seq: row.seq,
        eventId: row.event_id,
        orgId: row.org_id,
        mode: row.mode,
        passId: row.pass_id,
        templateId: row.template_id,
        externalId: row.external_id,
        type: row.type,
        kind: row.kind,
        device: row.device,
        deviceCount: row.device_count,
        actorType: row.actor_type,
        data: row.data,
        at: row.at,
      });
      const result = Object.values(results).find((r) => r.eventId === row.event_id);
      expect(envelope).toMatchObject({ mode: 'test', requestId: result?.requestId });
      expect(envelope.requestId).toBeTruthy();
    }
    const delivered = await deliveriesOf(kit.env.DB, endpoint);
    expect(delivered.filter((d) => d.mode === 'test')).toHaveLength(6);
    const scan = feed.find((r) => r.type === 'pass.scanned');
    expect(JSON.parse(scan?.data ?? '{}')).toMatchObject({ gate: 'Workbench', simulated: true });
    // The failed email shows in the Test inbox.
    const inbox = await app.request(
      `${ORIGIN}/api/v1/test-inbox?orgId=${kit.org.id}`,
      { headers: { ...session, 'x-passbook-mode': 'test' } },
      kit.env,
    );
    const items = ((await inbox.json()) as { items: { passId: string; failed: boolean }[] }).items;
    expect(items.find((i) => i.passId === pass.id)?.failed).toBe(true);
    const scans = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM scans WHERE pass_id = ?',
      [pass.id],
    );
    expect(scans?.n).toBe(0);
  });

  it('email_failed needs a Test-inbox message', async () => {
    const pass = await kit.pass({ mode: 'test' });
    await run(kit.env.DB, 'DELETE FROM captured_emails WHERE pass_id = ?', [pass.id]);
    const res = await simulate(pass.id, testKey, { event: 'email_failed' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('SIMULATE_NO_EMAIL');
  });

  it('limits to a stable code with Retry-After', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const real = kit.env.RL_SIMULATE;
    Object.assign(kit.env, { RL_SIMULATE: fakeRateLimiter({ limit: 1 }) });
    try {
      await send(pass.id, { event: 'installed' });
      const res = await simulate(pass.id, testKey, { event: 'installed' });
      expect(res.status).toBe(429);
      expect(((await res.json()) as { code: string }).code).toBe('SIMULATE_RATE_LIMITED');
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      Object.assign(kit.env, { RL_SIMULATE: real });
    }
  });

  it('refuses a pass of another org as not found', async () => {
    const other = await kit.pass({ mode: 'test' });
    const otherOrg = await makeOrg(kit.fx);
    const otherKey = (await makeApiKey(kit.fx, { orgId: otherOrg.id, mode: 'test' })).headers;
    const res = await simulate(other.id, otherKey, { event: 'installed' });
    expect([401, 403, 404]).toContain(res.status);
    const n = await all(kit.env.DB, 'SELECT 1 FROM pass_simulated_devices WHERE pass_id = ?', [
      other.id,
    ]);
    expect(n).toHaveLength(0);
  });
});

describe('device counts in webhooks', () => {
  const counts = async (passId: string) =>
    (await feedOf(kit.env.DB, passId))
      .filter((r) => r.type === 'pass.installed' || r.type === 'pass.uninstalled')
      .map((r) => r.device_count);

  it('Test counts simulated devices, matching the devices view', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const a = await send(pass.id, { event: 'installed' });
    await send(pass.id, { event: 'installed' });
    await send(pass.id, { event: 'uninstalled', deviceId: a.deviceId });
    expect(await counts(pass.id)).toEqual([1, 2, 1]);
    expect((await devices(pass.id)).filter((d) => d.registeredAt !== null)).toHaveLength(1);
  });

  it('Live counts real registrations only', async () => {
    const pass = await kit.pass();
    await kit.device(pass, 'live-device-1', 'token-1');
    await recordPassEvent(kit.ctx, {
      orgId: kit.org.id,
      passId: pass.id,
      mode: 'live',
      kind: 'device.registered',
      device: 'live-device-1',
    });
    expect(await counts(pass.id)).toEqual([1]);
  });
});
