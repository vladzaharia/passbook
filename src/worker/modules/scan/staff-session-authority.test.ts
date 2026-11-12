import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';
import { ORIGIN } from './test-kit.ts';

const fixture = staffSessionFixture();
beforeAll(fixture.setup);

describe('paired scanner staff sessions', () => {
  it('requires same-origin and CSRF on both mutations without changing either binding', async () => {
    const { kit, deskTemplate, session, signIn, binding, problem, signOut, getSession } = fixture;
    const current = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '631927' });
    const next = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '817263' });
    const scanner = await kit.scanner({
      templateIds: [deskTemplate],
      settings: { staffSignIn: true },
    });
    const neighbor = await kit.scanner({
      templateIds: [deskTemplate],
      settings: { staffSignIn: true },
    });
    await session(await signIn(scanner.headers, current), current.pin);
    await session(await signIn(neighbor.headers, next), next.pin);
    const original = await binding(scanner.id);
    const other = await binding(neighbor.id);
    const { 'x-csrf-token': _token, ...noToken } = scanner.headers;
    const { 'sec-fetch-site': _site, ...noSite } = scanner.headers;
    const { origin: _origin, ...noOriginOrSite } = noSite;
    const badHeaders = [
      { headers: noToken, code: 'CSRF_TOKEN' },
      { headers: { ...scanner.headers, 'x-csrf-token': 'incorrect' }, code: 'CSRF_TOKEN' },
      { headers: noOriginOrSite, code: 'CSRF_ORIGIN' },
      { headers: { ...noSite, origin: 'https://evil.test' }, code: 'CSRF_ORIGIN' },
      { headers: { ...scanner.headers, 'sec-fetch-site': 'cross-site' }, code: 'CSRF_ORIGIN' },
    ];
    for (const { headers, code } of badHeaders) {
      await problem(await signIn(headers, next), 403, code, next.pin);
      await problem(await signOut(headers), 403, code, next.pin);
      expect(await binding(scanner.id)).toEqual(original);
      expect(await binding(neighbor.id)).toEqual(other);
    }
    expect((await session(await getSession(scanner.headers), current.pin)).staff?.id).toBe(
      current.id,
    );
    expect((await session(await signOut(scanner.headers), current.pin)).state).toBe(
      'staff_required',
    );
    expect(await binding(neighbor.id)).toEqual(other);
  });

  it('keeps optional sign-in usable with its configured fallback and refuses a PIN', async () => {
    const {
      kit,
      deskTemplate,
      managerTemplate,
      staffHash,
      problem,
      signIn,
      binding,
      session,
      getSession,
      action,
    } = fixture;
    const manager = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      role: 'manager',
      pin: '749261',
    });
    const scanner = await kit.scanner({
      templateIds: [deskTemplate, managerTemplate],
      settings: { staffSignIn: false, roleWithoutSignIn: 'desk' },
    });
    const hash = await staffHash(manager);
    await problem(
      await signIn(scanner.headers, manager),
      403,
      'STAFF_SIGN_IN_DISABLED',
      manager.pin,
      hash,
    );
    expect(await binding(scanner.id)).toEqual({
      staffId: null,
      staffSince: null,
      staffSeenAt: null,
    });
    expect(await session(await getSession(scanner.headers), manager.pin, hash)).toMatchObject({
      state: 'ready',
      staff: null,
      staffList: null,
      scanner: { settings: { staffSignIn: false, roleWithoutSignIn: 'desk' } },
    });
    const needsManager = await action(scanner.headers, await kit.scanPass(managerTemplate));
    expect(needsManager.status).toBe(200);
    expect(await needsManager.json()).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    const deskAction = await action(scanner.headers, await kit.scanPass(deskTemplate));
    expect(deskAction.status).toBe(200);
    expect(await deskAction.json()).toMatchObject({ kind: 'ok' });
  });

  it('does not let bearer terminals or either screen role acquire a staff binding', async () => {
    const { kit, managerTemplate, binding, problem, signIn, signOut, session, getSession, action } =
      fixture;
    const manager = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      role: 'manager',
      pin: '928463',
    });
    const terminal = await kit.scanner({
      kind: 'terminal',
      templateIds: [managerTemplate],
      settings: { staffSignIn: true, roleWithoutSignIn: 'door' },
      staffId: manager.id,
    });
    const terminalHeaders = { ...terminal.headers, origin: ORIGIN };
    const staleTerminalBinding = await binding(terminal.id);
    await problem(
      await signIn(terminalHeaders, manager),
      403,
      'STAFF_SIGN_IN_UNAVAILABLE',
      manager.pin,
    );
    await problem(await signOut(terminalHeaders), 403, 'STAFF_SIGN_IN_UNAVAILABLE', manager.pin);
    expect(await binding(terminal.id)).toEqual(staleTerminalBinding);
    expect(await session(await getSession(terminalHeaders), manager.pin)).toMatchObject({
      state: 'ready',
      staff: null,
    });
    const terminalAction = await action(terminalHeaders, await kit.scanPass(managerTemplate));
    expect(terminalAction.status).toBe(200);
    expect(await terminalAction.json()).toMatchObject({
      kind: 'heads_up',
      reason: 'needs_approval',
    });

    for (const deviceRole of ['customer', 'monitor'] as const) {
      const screen = await kit.scanner({
        kind: 'display',
        deviceRole,
        settings: { staffSignIn: true },
        staffId: manager.id,
      });
      const stale = await binding(screen.id);
      await problem(await signIn(screen.headers, manager), 403, 'SCREEN_ONLY', manager.pin);
      await problem(await signOut(screen.headers), 403, 'SCREEN_ONLY', manager.pin);
      expect(await binding(screen.id)).toEqual(stale);
      expect(await session(await getSession(screen.headers), manager.pin)).toMatchObject({
        scanner: { deviceRole },
        staff: null,
      });
      await problem(
        await action(screen.headers, await kit.scanPass(managerTemplate)),
        403,
        'SCREEN_ONLY',
      );
    }
  });

  it('preserves scoped admin-as-scanner access without allowing a staff binding', async () => {
    const { kit, managerTemplate, fake, session, call, action, problem, binding } = fixture;
    const manager = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      role: 'manager',
      pin: '582741',
    });
    const scanner = await kit.scanner({
      templateIds: [managerTemplate],
      settings: { staffSignIn: true },
    });
    const admin = fake.admin();
    const scope = { orgId: kit.org.id, templateIds: [managerTemplate], timeZone: 'UTC' };
    const query = new URLSearchParams({
      orgId: kit.org.id,
      templateIds: managerTemplate,
      timeZone: 'UTC',
    });
    const view = await session(await call('GET', `/scan/session?${query}`, admin), manager.pin);
    expect(view).toMatchObject({ principal: 'admin', state: 'ready', staff: null, scanner: null });
    const result = await action(admin, await kit.scanPass(managerTemplate), scope);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ kind: 'ok' });
    await problem(
      await call('POST', '/scan/staff', admin, { staffId: manager.id, pin: manager.pin, scope }),
      403,
      'STAFF_SIGN_IN_UNAVAILABLE',
      manager.pin,
    );
    await problem(
      await call('DELETE', '/scan/staff', admin, { scope }),
      403,
      'STAFF_SIGN_IN_UNAVAILABLE',
      manager.pin,
    );
    expect(await binding(scanner.id)).toEqual({
      staffId: null,
      staffSince: null,
      staffSeenAt: null,
    });
  });
});
