import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeUser } from '../../../../test/helpers/index.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { CreatedScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import {
  CreatedScanningDeviceSchema,
  ScanningSessionDetailSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { createApp } from '../../app.ts';
import { createScannerStore } from './auth-store.ts';
import { getScanner } from './repo-device.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let userHeaders: Record<string, string>;
let call: (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<Response>;
beforeAll(async () => {
  kit = await setupScanKit();
  const fake = fakeAuth('https://wallet.test');
  await makeUser(kit.fx, { id: 'admin-1' });
  userHeaders = fake.user();
  const app = createApp({
    stores: { ...fake.stores, scanners: createScannerStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
  call = (method, path, body, headers = fake.admin()) =>
    Promise.resolve(
      app.request(
        `https://wallet.test/api/v1${path}`,
        {
          method,
          headers: { ...headers, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        kit.env,
      ),
    );
});

describe('shared scanning sessions', () => {
  it('creates a session with multiple independently paired devices and applies shared rules', async () => {
    const made = await call('POST', '/scanning-sessions', {
      orgId: kit.org.id,
      name: 'Membership entrance',
      timeZone: 'UTC',
      settings: { lookup: true, checkIn: { mode: 'in_out' } },
    });
    expect(made.status).toBe(201);
    const session = (await made.json()) as { id: string };
    const devices = [];
    for (const name of ['Entrance', 'Exit']) {
      const response = await call('POST', `/scanning-sessions/${session.id}/devices`, {
        name,
        surface: 'phone',
        overrides: { direction: name === 'Entrance' ? 'in' : 'out' },
      });
      expect(response.status).toBe(201);
      devices.push(
        (await response.json()) as {
          id: string;
          pairing: { code: string };
          settings: { checkIn: unknown; direction: string };
        },
      );
    }
    expect(devices[0]?.pairing.code).not.toBe(devices[1]?.pairing.code);
    expect(devices[0]?.settings).toMatchObject({ checkIn: { mode: 'in_out' }, direction: 'in' });
    const changed = await call('PATCH', `/scanning-sessions/${session.id}`, {
      settings: { flow: 'choose', checkIn: { mode: 'unlimited' } },
    });
    expect(changed.status).toBe(200);
    const detail = (await changed.json()) as { devices: { settings: unknown }[] };
    expect(detail.devices).toHaveLength(2);
    expect(detail.devices.map((d) => d.settings)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flow: 'choose',
          direction: 'in',
          checkIn: { mode: 'unlimited' },
        }),
        expect.objectContaining({
          flow: 'choose',
          direction: 'out',
          checkIn: { mode: 'unlimited' },
        }),
      ]),
    );
  });

  it('rejects device overrides of admission policy and non-admin administration', async () => {
    expect((await call('GET', '/scanning-sessions', undefined, userHeaders)).status).toBe(403);
    const made = await call('POST', '/scanning-sessions', {
      orgId: kit.org.id,
      name: 'Admission',
      timeZone: 'UTC',
    });
    expect(made.status).toBe(201);
    const session = (await made.json()) as { id: string };
    const response = await call('POST', `/scanning-sessions/${session.id}/devices`, {
      name: 'Bypass',
      overrides: { checkIn: { mode: 'unlimited' } },
    });
    expect(response.status).toBe(422);
  });
});
describe('legacy standalone monitors', () => {
  it('remain read-only when they report device capabilities', async () => {
    const source = await kit.scanner();
    const created = await call('POST', '/scan-setups', {
      orgId: kit.org.id,
      name: 'Legacy desk monitor',
      deviceRole: 'monitor',
      timeZone: 'UTC',
      watch: { scannerIds: [source.id], allOrg: false },
    });
    expect(created.status).toBe(201);
    const setup = CreatedScannerSetupSchema.parse(await created.json());
    const headers = await pair(setup.pairing?.code ?? '');
    const report = await call(
      'POST',
      '/scan/device',
      {
        capabilities: {
          width: 1440,
          height: 900,
          touch: false,
          camera: 'available',
          keyboard: true,
          nativeBarcode: false,
          surfaces: ['phone', 'operator', 'customer'],
          preferred: 'operator',
        },
      },
      headers,
    );
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({
      device: { surface: 'desk', effectiveSurface: 'desk' },
    });
    const action = await call(
      'POST',
      '/scan/resolve',
      {
        idempotencyKey: kit.fx.ids.id(),
        input: { code: 'x', method: 'camera' },
        clientTs: kit.clock.now(),
      },
      headers,
    );
    expect(action.status).toBe(403);
  });
});

async function parent(name: string) {
  const response = await call('POST', '/scanning-sessions', {
    orgId: kit.org.id,
    name,
    timeZone: 'UTC',
  });
  expect(response.status).toBe(201);
  return ScanningSessionDetailSchema.parse(await response.json());
}
async function device(sessionId: string, name: string, surface = 'auto') {
  const response = await call('POST', `/scanning-sessions/${sessionId}/devices`, { name, surface });
  expect(response.status).toBe(201);
  return CreatedScanningDeviceSchema.parse(await response.json());
}
async function pair(code: string) {
  const response = await call('POST', '/scan/pair', { code }, { origin: 'https://wallet.test' });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const data = ScanSessionSchema.parse(await response.json());
  return { cookie, origin: 'https://wallet.test', 'x-csrf-token': data.csrfToken ?? '' };
}

describe('session device authorization and live configuration', () => {
  it('reuses an administrator device per browser and session, without giving it a pairing token', async () => {
    const first = await parent('Admin membership');
    const second = await parent('Admin event');
    const deviceKey = '11111111-1111-4111-8111-111111111111';
    const join = async (sessionId: string, key = deviceKey) => {
      const response = await call('POST', '/scanning-sessions/join', { sessionId, deviceKey: key });
      expect(response.status).toBe(200);
      return (await response.json()) as { setupId: string; orgId: string; timeZone: string };
    };
    const joined = await join(first.id);
    expect(await join(first.id)).toEqual(joined);
    expect((await join(second.id)).setupId).not.toBe(joined.setupId);
    expect((await join(first.id, '22222222-2222-4222-8222-222222222222')).setupId).not.toBe(
      joined.setupId,
    );
    expect((await getScanner(kit.env.DB, joined.setupId))?.tokenHash).toBeNull();
    const scope = new URLSearchParams(joined);
    const session = await call('GET', `/scan/session?${scope}`);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      principal: 'admin',
      workspace: { device: { signIn: 'admin' }, session: { id: first.id } },
    });
    const other = await makeUser(kit.fx);
    expect(
      (
        await call(
          'GET',
          `/scan/session?${scope}`,
          undefined,
          fakeAuth('https://wallet.test').session({ userId: other.id, roles: ['admin'] }),
        )
      ).status,
    ).toBe(403);
  });

  it('keeps scanner, operator and customer views available across screen sizes', async () => {
    const session = await parent('Capabilities');
    const made = await device(session.id, 'Wide scanner');
    const headers = await pair(made.pairing?.code ?? '');
    const report = (width: number) =>
      call(
        'POST',
        '/scan/device',
        {
          capabilities: {
            width,
            height: 800,
            touch: true,
            camera: 'available',
            keyboard: true,
            nativeBarcode: false,
            surfaces: ['operator'],
            preferred: 'operator',
          },
        },
        headers,
      );
    const small = await report(390);
    expect(small.status).toBe(200);
    expect(await small.json()).toMatchObject({
      device: {
        effectiveSurface: 'phone',
        capabilities: { surfaces: ['phone', 'operator', 'customer'] },
      },
    });
    const wide = await report(1200);
    expect(await wide.json()).toMatchObject({ device: { effectiveSurface: 'operator' } });
    const layout = await call('PATCH', `/scanning-sessions/${session.id}/devices/${made.id}`, {
      surface: 'customer',
    });
    expect(layout.status).toBe(200);
    expect(await (await report(390)).json()).toMatchObject({
      device: { effectiveSurface: 'customer' },
    });
    expect(
      (
        await call(
          'POST',
          '/scan/resolve',
          {
            idempotencyKey: kit.fx.ids.id(),
            input: { code: 'x', method: 'camera' },
            clientTs: kit.clock.now(),
          },
          headers,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call('PATCH', `/scanning-sessions/${session.id}/devices/${made.id}`, {
          surface: 'operator',
        })
      ).status,
    ).toBe(200);
    expect(await (await report(390)).json()).toMatchObject({
      device: { effectiveSurface: 'operator' },
    });
    const operatorAction = await call(
      'POST',
      '/scan/resolve',
      {
        idempotencyKey: kit.fx.ids.id(),
        input: { code: 'x', method: 'camera' },
        clientTs: kit.clock.now(),
      },
      headers,
    );
    expect(operatorAction.status).toBe(200);
  });
  it('folds the persisted desk layout into the operator view', async () => {
    const session = await parent('Legacy desk');
    const made = await device(session.id, 'Legacy desk', 'desk');
    const headers = await pair(made.pairing?.code ?? '');
    const report = await call(
      'POST',
      '/scan/device',
      {
        capabilities: {
          width: 390,
          height: 844,
          touch: true,
          camera: 'available',
          keyboard: true,
          nativeBarcode: false,
          surfaces: ['phone', 'customer'],
          preferred: 'phone',
        },
      },
      headers,
    );
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({
      device: {
        surface: 'desk',
        effectiveSurface: 'operator',
        capabilities: { surfaces: ['phone', 'operator', 'customer'] },
      },
    });
    expect(
      (
        await call(
          'POST',
          '/scan/resolve',
          {
            idempotencyKey: kit.fx.ids.id(),
            input: { code: 'x', method: 'camera' },
            clientTs: kit.clock.now(),
          },
          headers,
        )
      ).status,
    ).toBe(200);
  });
  it('keeps standalone legacy desk monitors read-only when they report capabilities', async () => {
    const source = await kit.scanner();
    const created = await call('POST', '/scan-setups', {
      orgId: kit.org.id,
      name: `Legacy desk monitor ${kit.fx.ids.token(8)}`,
      deviceRole: 'monitor',
      timeZone: 'UTC',
      watch: { scannerIds: [source.id], allOrg: false },
    });
    expect(created.status).toBe(201);
    const setup = CreatedScannerSetupSchema.parse(await created.json());
    const headers = await pair(setup.pairing?.code ?? '');
    const report = await call(
      'POST',
      '/scan/device',
      {
        capabilities: {
          width: 1440,
          height: 900,
          touch: false,
          camera: 'available',
          keyboard: true,
          nativeBarcode: false,
          surfaces: ['phone', 'operator', 'customer'],
          preferred: 'operator',
        },
      },
      headers,
    );
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({
      device: { surface: 'desk', effectiveSurface: 'desk' },
    });
    const action = await call(
      'POST',
      '/scan/resolve',
      {
        idempotencyKey: kit.fx.ids.id(),
        input: { code: 'x', method: 'camera' },
        clientTs: kit.clock.now(),
      },
      headers,
    );
    expect(action.status).toBe(403);
  });

  it('applies admission immediately, preserves device overrides, and pauses every input route', async () => {
    const session = await parent('Live rules');
    const made = await device(session.id, 'Live rules scanner', 'phone');
    const headers = await pair(made.pairing?.code ?? '');
    expect(
      (
        await call('PATCH', `/scanning-sessions/${session.id}/devices/${made.id}`, {
          overrides: { flow: 'choose', showPhoto: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('PATCH', `/scanning-sessions/${session.id}`, {
          settings: { flow: 'auto', checkIn: { mode: 'single' } },
        })
      ).status,
    ).toBe(200);
    const read = await call('GET', '/scan/session', undefined, headers);
    expect(await read.json()).toMatchObject({
      scanner: { settings: { flow: 'choose', showPhoto: false, checkIn: { mode: 'single' } } },
    });
    const paused = await call('PATCH', `/scanning-sessions/${session.id}`, { status: 'paused' });
    expect(paused.status).toBe(200);
    expect(
      (
        await call(
          'POST',
          '/scan/resolve',
          {
            idempotencyKey: kit.fx.ids.id(),
            input: { code: 'x', method: 'manual' },
            clientTs: kit.clock.now(),
          },
          headers,
        )
      ).status,
    ).toBe(403);
    expect(await (await call('GET', '/scan/session', undefined, headers)).json()).toMatchObject({
      workspace: { session: { status: 'paused' } },
    });
  });

  it('rejects stale session and device edits and atomically accepts only one concurrent revision', async () => {
    const session = await parent('Revisions');
    const responses = await Promise.all(
      ['First name', 'Second name'].map((name) =>
        call('PATCH', `/scanning-sessions/${session.id}`, { name, revision: session.updatedAt }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const made = await device(session.id, 'Revision device', 'phone');
    expect(
      (
        await call('PATCH', `/scanning-sessions/${session.id}/devices/${made.id}`, {
          name: 'Renamed device',
          revision: made.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('PATCH', `/scanning-sessions/${session.id}/devices/${made.id}`, {
          name: 'Stale device',
          revision: made.updatedAt,
        })
      ).status,
    ).toBe(409);
  });
});
