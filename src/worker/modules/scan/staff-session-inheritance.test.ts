import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { CreatedScanningDeviceSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { run } from '../../platform/db.ts';
import { getScanner } from './repo-device.ts';
import { type Headers, staffSessionFixture } from './staff-session-test-fixtures.ts';
import { ORIGIN } from './test-kit.ts';

const fixture = staffSessionFixture();
beforeAll(fixture.setup);

describe('shared scanning session settings', () => {
  it('uses inherited sign-in and clears stale privilege after the parent switches it off', async () => {
    const {
      kit,
      fake,
      deskTemplate,
      call,
      session,
      getSession,
      signIn,
      signOut,
      action,
      binding,
      problem,
      staffHash,
    } = fixture;
    const manager = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      role: 'manager',
      pin: '762491',
    });
    const event = await kit.event({ templateIds: [deskTemplate] });
    const admin = fake.admin();
    const created = await call('POST', '/scanning-sessions', admin, {
      orgId: kit.org.id,
      name: 'Inherited staff settings',
      timeZone: 'UTC',
      accepts: { eventId: event.id },
      settings: { staffSignIn: false, roleWithoutSignIn: 'door' },
    });
    expect(created.status).toBe(201);
    const parent = (await created.json()) as { id: string };
    const devices: { id: string; headers: Headers }[] = [];
    for (const name of ['First scanner', 'Neighbor scanner']) {
      const response = await call('POST', `/scanning-sessions/${parent.id}/devices`, admin, {
        name,
        surface: 'phone',
      });
      expect(response.status).toBe(201);
      const device = CreatedScanningDeviceSchema.parse(await response.json());
      const paired = await call(
        'POST',
        '/scan/pair',
        { origin: ORIGIN },
        {
          code: device.pairing?.code ?? '',
        },
      );
      expect(paired.status).toBe(200);
      const cookie = paired.headers.get('set-cookie')?.split(';')[0] ?? '';
      expect(cookie).not.toBe('');
      const pairedSession = ScanSessionSchema.parse(await paired.json());
      expect(pairedSession.csrfToken).toBeTruthy();
      devices.push({
        id: device.id,
        headers: { cookie, origin: ORIGIN, 'x-csrf-token': pairedSession.csrfToken ?? '' },
      });
    }
    const [scanner, neighbor] = devices;
    if (!scanner || !neighbor) throw new Error('Expected both paired scanners');
    const enabled = await call('PATCH', `/scanning-sessions/${parent.id}`, admin, {
      settings: { staffSignIn: true },
    });
    expect(enabled.status).toBe(200);
    // A stale local settings snapshot must not override the live parent policy.
    await run(
      kit.env.DB,
      "UPDATE scanners SET settings = json_set(settings, '$.staffSignIn', json('false')) WHERE id = ?",
      [scanner.id],
    );
    expect(await session(await getSession(scanner.headers), manager.pin)).toMatchObject({
      state: 'staff_required',
      staff: null,
      scanner: { settings: { staffSignIn: true } },
      event: { id: event.id },
      templates: [{ id: deskTemplate }],
      workspace: { session: { id: parent.id } },
    });
    expect(await session(await signIn(scanner.headers, manager), manager.pin)).toMatchObject({
      state: 'ready',
      staff: { id: manager.id, role: 'manager' },
      scanner: { settings: { staffSignIn: true } },
      event: { id: event.id },
      templates: [{ id: deskTemplate }],
      workspace: { session: { id: parent.id } },
    });
    const firstBinding = await getScanner(kit.env.DB, scanner.id);
    if (!firstBinding) throw new Error('Missing signed-in scanner.');
    expect(await session(await signOut(scanner.headers), manager.pin)).toMatchObject({
      state: 'staff_required',
      staff: null,
      event: { id: event.id },
      workspace: { session: { id: parent.id } },
    });
    const signedOut = await getScanner(kit.env.DB, scanner.id);
    if (!signedOut) throw new Error('Missing signed-out scanner.');
    expect(signedOut.updatedAt).toBeGreaterThan(firstBinding.updatedAt);
    expect(await session(await signIn(scanner.headers, manager), manager.pin)).toMatchObject({
      state: 'ready',
      staff: { id: manager.id, role: 'manager' },
      workspace: { session: { id: parent.id } },
    });
    expect((await getScanner(kit.env.DB, scanner.id))?.updatedAt).toBeGreaterThan(
      signedOut.updatedAt,
    );
    await session(await signIn(neighbor.headers, manager), manager.pin);
    const privileged = await action(scanner.headers, await kit.scanPass(deskTemplate));
    expect(privileged.status).toBe(200);
    expect(await privileged.json()).toMatchObject({ kind: 'ok' });
    const other = await binding(neighbor.id);
    const disabled = await call('PATCH', `/scanning-sessions/${parent.id}`, admin, {
      settings: { staffSignIn: false, roleWithoutSignIn: 'door' },
    });
    expect(disabled.status).toBe(200);
    expect((await binding(scanner.id)).staffId).toBe(manager.id);
    expect(await binding(neighbor.id)).toEqual(other);

    // The first ordinary read clears the no-longer-allowed binding and still returns
    // the exact linked workspace rather than rejecting its own new device revision.
    const cleared = await session(
      await getSession(scanner.headers),
      manager.pin,
      await staffHash(manager),
    );
    expect(cleared).toMatchObject({
      state: 'ready',
      staff: null,
      scanner: { settings: { staffSignIn: false, roleWithoutSignIn: 'door' } },
      event: { id: event.id },
      templates: [{ id: deskTemplate }],
      workspace: { session: { id: parent.id } },
    });
    expect(await binding(scanner.id)).toEqual({
      staffId: null,
      staffSince: null,
      staffSeenAt: null,
    });
    expect(await binding(neighbor.id)).toEqual(other);
    await problem(
      await signIn(scanner.headers, manager),
      403,
      'STAFF_SIGN_IN_DISABLED',
      manager.pin,
    );
    const restricted = await action(scanner.headers, await kit.scanPass(deskTemplate));
    expect(restricted.status).toBe(200);
    expect(await restricted.json()).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    expect((await session(await getSession(neighbor.headers), manager.pin)).staff).toBeNull();
    expect(await binding(neighbor.id)).toEqual({
      staffId: null,
      staffSince: null,
      staffSeenAt: null,
    });
  });
});
