import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { CreatedScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import { getScanner } from './repo-device.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

describe('session device authorization and live configuration', () => {
  it('reuses an administrator device per browser and session, without giving it a pairing token', async () => {
    const { kit, parent, call, fake } = fixture;
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
    await grantScanMembership(kit.fx, kit.org.id, other.id);
    expect(
      (
        await call(
          'GET',
          `/scan/session?${scope}`,
          undefined,
          fake.session({ userId: other.id, roles: ['admin'] }),
        )
      ).status,
    ).toBe(403);
  });

  it('keeps scanner, operator and customer views available across screen sizes', async () => {
    const { kit, parent, device, pair, call } = fixture;
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
    const { kit, parent, device, pair, call } = fixture;
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
    const { kit, call, pair } = fixture;
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
    const { kit, parent, device, pair, call } = fixture;
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
    const { parent, call, device } = fixture;
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

  it('a name-only edit keeps a screen a screen, and a screen cannot sign staff in', async () => {
    const { kit, parent, device, pair, call } = fixture;
    const session = await parent('Screens');
    const made = await device(session.id, 'Customer screen', 'customer');
    expect(made.pairing).not.toBeNull();
    const headers = await pair(made.pairing?.code ?? '');
    const renamed = await call('PATCH', `/scanning-sessions/${session.id}/devices/${made.id}`, {
      name: 'Front screen',
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      name: 'Front screen',
      surface: 'customer',
      effectiveSurface: 'customer',
    });
    expect(
      await kit.env.DB.prepare('SELECT device_role FROM scanners WHERE id = ?')
        .bind(made.id)
        .first(),
    ).toEqual({ device_role: 'customer' });
    const signIn = await call(
      'POST',
      '/scan/staff',
      { staffId: kit.fx.ids.id(), pin: '123456' },
      headers,
    );
    expect(signIn.status).toBe(403);
    expect(await signIn.json()).toMatchObject({ code: 'SCREEN_ONLY' });
  });
});
