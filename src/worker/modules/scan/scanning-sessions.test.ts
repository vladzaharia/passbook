import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { CreatedScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import {
  ScanningSessionDetailSchema,
  ScanningSessionListSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

describe('shared scanning sessions', () => {
  it('creates a session with multiple independently paired devices and applies shared rules', async () => {
    const { kit, call } = fixture;
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

  it('rejects device overrides of admission policy and unauthorized administration', async () => {
    const { kit, call, userHeaders } = fixture;
    expect(
      (await call('GET', `/scanning-sessions?orgId=${kit.org.id}`, undefined, userHeaders)).status,
    ).toBe(403);
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

  it('allows a read-only member to list only their organization, but not manage sessions', async () => {
    const { kit, fake, call } = fixture;
    const reader = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, reader.id, ['read_only']);
    const headers = fake.session({ userId: reader.id, roles: ['user'] });
    const other = await makeOrg(kit.fx);
    await grantScanMembership(kit.fx, other.id, 'admin-1');
    const input = { name: 'Tenant scope', timeZone: 'UTC' };
    const mine = await call('POST', '/scanning-sessions', { ...input, orgId: kit.org.id });
    const theirs = await call('POST', '/scanning-sessions', { ...input, orgId: other.id });
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    const own = ScanningSessionDetailSchema.parse(await mine.json());
    const foreign = ScanningSessionDetailSchema.parse(await theirs.json());

    expect(
      (await call('GET', `/scanning-sessions?orgId=${kit.org.id}`, undefined, headers)).status,
    ).toBe(200);
    expect(
      (await call('GET', `/scanning-sessions?orgId=${other.id}`, undefined, headers)).status,
    ).toBe(403);
    expect(
      (await call('POST', '/scanning-sessions', { ...input, orgId: kit.org.id }, headers)).status,
    ).toBe(403);
    const all = await call('GET', '/scanning-sessions', undefined, headers);
    expect(all.status).toBe(200);
    const ids = ScanningSessionListSchema.parse(await all.json()).items.map((item) => item.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(foreign.id);
  });
});
describe('legacy standalone monitors', () => {
  it('remain read-only when they report device capabilities', async () => {
    const { kit, call, pair } = fixture;
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
