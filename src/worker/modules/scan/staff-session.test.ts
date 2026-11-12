import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';

const fixture = staffSessionFixture();
beforeAll(fixture.setup);

describe('paired scanner staff sessions', () => {
  it('binds a real PIN, applies the staff role, reloads identity, and signs out only this device', async () => {
    const {
      kit,
      managerTemplate,
      staffHash,
      session,
      getSession,
      problem,
      action,
      signIn,
      binding,
      signOut,
    } = fixture;
    const manager = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      name: 'Morgan Manager',
      role: 'manager',
      pin: '482913',
    });
    const door = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      name: 'Dana Door',
      role: 'door',
      pin: '736204',
    });
    const hash = await staffHash(manager);
    const event = await kit.event({ mode: 'test', templateIds: [managerTemplate] });
    const scanner = await kit.scanner({
      mode: 'test',
      eventId: event.id,
      settings: { staffSignIn: true, roleWithoutSignIn: 'door' },
    });
    const neighbor = await kit.scanner({
      mode: 'test',
      eventId: event.id,
      settings: { staffSignIn: true },
    });
    const pass = await kit.scanPass(managerTemplate, {}, { mode: 'test' });
    const before = await session(await getSession(scanner.headers), manager.pin, hash);
    expect(before).toMatchObject({
      principal: 'scanner',
      state: 'staff_required',
      staff: null,
      scanner: { id: scanner.id, mode: 'test', orgId: kit.org.id },
      event: { id: event.id },
      templates: [{ id: managerTemplate }],
    });
    expect(before.staffList).toContainEqual({
      id: manager.id,
      name: manager.name,
      role: 'manager',
    });
    await problem(await action(scanner.headers, pass), 403, 'STAFF_REQUIRED', manager.pin, hash);

    const signed = await session(await signIn(scanner.headers, manager), manager.pin, hash);
    expect(signed).toMatchObject({
      state: 'ready',
      staff: { id: manager.id, name: manager.name, role: 'manager' },
      scanner: { id: scanner.id, mode: 'test', orgId: kit.org.id },
      event: { id: event.id },
      templates: [{ id: managerTemplate }],
    });
    expect(await binding(scanner.id)).toMatchObject({
      staffId: manager.id,
      staffSince: kit.clock.now(),
      staffSeenAt: kit.clock.now(),
    });
    expect(await session(await getSession(scanner.headers), manager.pin, hash)).toMatchObject({
      state: 'ready',
      staff: { id: manager.id, name: manager.name, role: 'manager' },
      scanner: { mode: 'test', orgId: kit.org.id },
      event: { id: event.id },
      templates: [{ id: managerTemplate }],
    });
    expect((await session(await signIn(neighbor.headers, door), door.pin)).staff).toEqual({
      id: door.id,
      name: door.name,
      role: 'door',
    });
    const neighborBinding = await binding(neighbor.id);
    const denied = await action(neighbor.headers, pass);
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    const allowed = await action(scanner.headers, pass);
    expect(allowed.status).toBe(200);
    const result = (await allowed.json()) as { kind: string; scanId: string };
    expect(result.kind).toBe('ok');
    expect(
      await first(kit.env.DB, 'SELECT staff_id, event_id, mode FROM scans WHERE id = ?', [
        result.scanId,
      ]),
    ).toEqual({ staff_id: manager.id, event_id: event.id, mode: 'test' });

    // The binding is an ID, not a cached name or privilege claim from the sign-in response.
    await run(kit.env.DB, 'UPDATE scan_staff SET name = ?, role = ? WHERE id = ?', [
      'Morgan Updated',
      'desk',
      manager.id,
    ]);
    expect(await session(await getSession(scanner.headers), manager.pin, hash)).toMatchObject({
      staff: { id: manager.id, name: 'Morgan Updated', role: 'desk' },
      event: { id: event.id },
      scanner: { mode: 'test' },
    });
    const nowDenied = await action(
      scanner.headers,
      await kit.scanPass(managerTemplate, {}, { mode: 'test' }),
    );
    expect(nowDenied.status).toBe(200);
    expect(await nowDenied.json()).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });

    const signedOut = await session(await signOut(scanner.headers), manager.pin, hash);
    expect(signedOut).toMatchObject({
      state: 'staff_required',
      staff: null,
      scanner: { id: scanner.id, mode: 'test', orgId: kit.org.id },
      event: { id: event.id },
      templates: [{ id: managerTemplate }],
    });
    expect(await binding(scanner.id)).toEqual({
      staffId: null,
      staffSince: null,
      staffSeenAt: null,
    });
    expect(await binding(neighbor.id)).toEqual(neighborBinding);
    expect((await session(await getSession(neighbor.headers), door.pin)).staff).toEqual({
      id: door.id,
      name: door.name,
      role: 'door',
    });
    expect((await session(await getSession(scanner.headers), manager.pin, hash)).state).toBe(
      'staff_required',
    );
    await problem(await action(scanner.headers, pass), 403, 'STAFF_REQUIRED');
  });

  it('signs in on the first request after clearing an expired staff binding', async () => {
    const { kit, deskTemplate, session, signIn, binding } = fixture;
    const old = await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'door' });
    const next = await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'desk' });
    const scanner = await kit.scanner({
      templateIds: [deskTemplate],
      settings: { staffSignIn: true },
      staffId: old.id,
      staffSince: kit.clock.now() - 16 * 60_000,
      staffSeenAt: kit.clock.now() - 16 * 60_000,
    });
    const signed = await session(await signIn(scanner.headers, next), next.pin);
    expect(signed.staff).toEqual({ id: next.id, name: next.name, role: 'desk' });
    expect((await binding(scanner.id)).staffId).toBe(next.id);
  });
});
