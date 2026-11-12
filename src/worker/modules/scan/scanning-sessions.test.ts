import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { CreatedScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import {
  ScanningSessionDetailSchema,
  ScanningSessionListSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { makePng } from '../templates/package/fixtures.ts';
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

describe('scanner organization branding', () => {
  it('projects a minimal org brand and serves only the paired actor’s logo', async () => {
    const { kit, call, parent, device, pair } = fixture;
    const x3 = makePng(480, 150);
    const x2 = makePng(320, 100);
    const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
    const uploaded = await call('PUT', `/orgs/${kit.org.id}/branding/logo`, {
      x3: encoded(x3),
      x2: encoded(x2),
    });
    expect(uploaded.status).toBe(200);
    const updated = await call('PATCH', `/orgs/${kit.org.id}`, {
      branding: {
        accent: '#0f766e',
        passColors: { background: '#0f172a', foreground: '#ffffff', label: '#94a3b8' },
      },
    });
    expect(updated.status).toBe(200);

    const session = await parent('Branded session');
    const scanner = await device(session.id, 'Branded scanner');
    const headers = await pair(scanner.pairing?.code ?? '');
    const sessionResponse = await call('GET', '/scan/session', undefined, headers);
    expect(sessionResponse.status).toBe(200);
    const scanSession = ScanSessionSchema.parse(await sessionResponse.json());
    expect(scanSession.branding).toEqual({
      accent: '#0f766e',
      logo: expect.objectContaining({ w: 480, h: 150, sha: expect.any(String) }),
    });

    const image = await call('GET', '/scan/branding/logo', undefined, headers);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('private, no-cache');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(x3);

    const etag = image.headers.get('etag');
    expect(etag).toBeTruthy();
    const cached = await call('GET', '/scan/branding/logo', undefined, {
      ...headers,
      'if-none-match': etag ?? '',
    });
    expect(cached.status).toBe(304);
    expect(
      (await call('GET', `/scan/branding/logo?orgId=${kit.org.id}`, undefined, headers)).status,
    ).toBe(422);
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
