import { beforeAll, describe, expect, it } from 'vitest';
import { type FakeAuth, fakeAuth, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import {
  AdminScannerStartedSchema,
  CreatedScannerSetupSchema,
  ScannerSetupSchema,
} from '../../../shared/contracts/scan-setups.ts';
import { createApp } from '../../app.ts';
import { createScannerStore } from './auth-store.ts';
import { getScanner } from './repo-device.ts';
import { grantScanMembership, type ScanKit, setupScanKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
let fake: FakeAuth;
let kit: ScanKit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await setupScanKit();
  fake = fakeAuth(ORIGIN);
  fake.bindSessions(kit.env.DB, kit.clock);
  app = createApp({
    stores: { ...fake.stores, scanners: createScannerStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
});
const send = (path: string, method = 'GET', body?: unknown, headers = fake.admin()) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const start = async (orgId = kit.org.id, headers = fake.admin()) => {
  const response = await send(
    '/scan-setups/admin-session',
    'POST',
    { orgId, timeZone: 'UTC' },
    headers,
  );
  expect(response.status).toBe(200);
  return AdminScannerStartedSchema.parse(await response.json());
};

describe('managed scanner setups', () => {
  it('creates one persistent admin setup per user, organization and mode', async () => {
    const first = await start();
    expect(await start()).toEqual(first);
    const other = await makeOrg(kit.fx);
    await grantScanMembership(kit.fx, other.id, 'admin-1');
    expect((await start(other.id)).setupId).not.toBe(first.setupId);
    expect((await start(kit.org.id, fake.admin({ mode: 'test' }))).setupId).not.toBe(first.setupId);
    const view = ScannerSetupSchema.parse(
      await (await send(`/scan-setups/${first.setupId}`)).json(),
    );
    expect(view).toMatchObject({
      adminSession: true,
      adminUser: { id: 'admin-1' },
      accepts: null,
      settings: { flow: 'auto' },
    });
    expect((await getScanner(kit.env.DB, first.setupId))?.tokenHash).toBeNull();
  });

  it('requires an explicit membership even for a platform administrator', async () => {
    const other = await makeOrg(kit.fx);
    const body = { orgId: other.id, timeZone: 'UTC' };
    expect((await send('/scan-setups/admin-session', 'POST', body)).status).toBe(403);

    const member = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, other.id, member.id);
    const headers = fake.session({ userId: member.id, roles: ['user'] });
    expect((await send('/scan-setups/admin-session', 'POST', body, headers)).status).toBe(200);
  });

  it('uses managed settings and refuses another admin’s setup', async () => {
    const setup = await start();
    expect(
      (
        await send(`/scan-setups/${setup.setupId}`, 'PATCH', {
          settings: { flow: 'auto', showPhoto: false },
        })
      ).status,
    ).toBe(200);
    const query = new URLSearchParams(setup);
    const response = await send(`/scan/session?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      principal: 'admin',
      scanner: { id: setup.setupId, settings: { flow: 'auto', showPhoto: false } },
    });
    const other = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, other.id);
    const denied = await send(
      `/scan/session?${query}`,
      'GET',
      undefined,
      fake.session({ userId: other.id, roles: ['admin'] }),
    );
    expect(denied.status).toBe(403);
  });

  it('never issues a device credential for an admin-owned setup', async () => {
    const setup = await start();
    for (const action of ['pairing', 'pair-here']) {
      const response = await send(`/scanners/${setup.setupId}/${action}`, 'POST');
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'SCANNER_NOT_PAIRABLE' });
    }
  });

  it('pairs a dedicated screen and keeps it read only', async () => {
    const source = await kit.scanner();
    const event = await kit.event({});
    const response = await send('/scan-setups', 'POST', {
      orgId: kit.org.id,
      name: 'Customer display',
      kind: 'display',
      accepts: { eventId: event.id },
      settings: { staffSignIn: true },
      deviceRole: 'customer',
      timeZone: 'UTC',
      watch: { scannerIds: [source.id] },
    });
    expect(response.status).toBe(201);
    const screen = CreatedScannerSetupSchema.parse(await response.json());
    const paired = await send(
      '/scan/pair',
      'POST',
      { code: screen.pairing?.code },
      { origin: ORIGIN },
    );
    expect(paired.status).toBe(200);
    const session = (await paired.json()) as { csrfToken: string; state: string };
    expect(session.state).toBe('ready');
    expect(session).toMatchObject({ templates: [], event: null, staff: null, staffList: null });
    const headers = {
      cookie: paired.headers.get('set-cookie')?.split(';')[0] ?? '',
      origin: ORIGIN,
      'x-csrf-token': session.csrfToken,
    };
    expect((await send('/scan/session', 'GET', undefined, headers)).status).toBe(200);
    expect(
      (await send('/scan/resolve', 'POST', { input: { code: 'x', method: 'camera' } }, headers))
        .status,
    ).toBe(403);
    expect((await send('/scan/live', 'GET', undefined, headers)).status).toBe(200);
  });

  it('rejects an org-wide customer screen, wrong-tenant targets and unsupported roles', async () => {
    const other = await makeOrg(kit.fx);
    const source = await kit.scanner({ orgId: other.id });
    for (const over of [
      { deviceRole: 'customer', watch: { allOrg: true } },
      { deviceRole: 'monitor', watch: { scannerIds: [source.id] } },
      { kind: 'display', deviceRole: 'scan' },
    ]) {
      const response = await send('/scan-setups', 'POST', {
        orgId: kit.org.id,
        name: 'Invalid setup',
        timeZone: 'UTC',
        ...over,
      });
      expect([404, 422]).toContain(response.status);
    }
  });

  it('revokes an admin session and permits an explicitly started replacement', async () => {
    const setup = await start();
    expect((await send(`/scanners/${setup.setupId}/revoke`, 'POST')).status).toBe(200);
    expect((await send(`/scan/session?${new URLSearchParams(setup)}`)).status).toBe(403);
    expect((await start()).setupId).not.toBe(setup.setupId);
  });

  it('requires an admin session for setup creation', async () => {
    expect(
      (
        await send(
          '/scan-setups/admin-session',
          'POST',
          { orgId: kit.org.id, timeZone: 'UTC' },
          fake.user(),
        )
      ).status,
    ).toBe(403);
  });

  it('saves a screen with deviceRole and watch, as the console does on every save', async () => {
    const source = await kit.scanner();
    const made = await send('/scan-setups', 'POST', {
      orgId: kit.org.id,
      name: 'Door monitor',
      kind: 'display',
      deviceRole: 'monitor',
      timeZone: 'UTC',
      watch: { allOrg: true },
    });
    expect(made.status).toBe(201);
    const { id } = CreatedScannerSetupSchema.parse(await made.json());
    const renamed = await send(`/scan-setups/${id}`, 'PATCH', {
      name: 'Door monitor 2',
      deviceRole: 'monitor',
      watch: { allOrg: true, scannerIds: [] },
    });
    expect(renamed.status).toBe(200);
    expect(ScannerSetupSchema.parse(await renamed.json())).toMatchObject({
      name: 'Door monitor 2',
      watch: { allOrg: true },
    });
    const follow = await send(`/scan-setups/${id}`, 'PATCH', {
      watch: { allOrg: false, scannerIds: [source.id] },
    });
    expect(follow.status).toBe(200);
    expect(ScannerSetupSchema.parse(await follow.json()).watch).toMatchObject({
      scannerIds: [source.id],
    });
    const scan = await send(`/scan-setups/${source.id}`, 'PATCH', {
      name: 'Gate 1',
      deviceRole: 'scan',
      watch: null,
    });
    expect(scan.status).toBe(200);
  });

  it('refuses to edit a setup from the other mode', async () => {
    const made = await send('/scan-setups', 'POST', {
      orgId: kit.org.id,
      name: 'Live monitor',
      kind: 'display',
      deviceRole: 'monitor',
      timeZone: 'UTC',
      watch: { allOrg: true },
    });
    const { id } = CreatedScannerSetupSchema.parse(await made.json());
    const testMode = fake.admin({ mode: 'test' });
    expect((await send(`/scan-setups/${id}`, 'PATCH', { name: 'Nope' }, testMode)).status).toBe(
      404,
    );
    expect((await send(`/scan-setups/${id}`, 'GET', undefined, testMode)).status).toBe(404);
  });
});
