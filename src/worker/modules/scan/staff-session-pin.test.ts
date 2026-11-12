import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeScanStaff } from '../../../../test/helpers/index.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';

const fixture = staffSessionFixture();
beforeAll(fixture.setup);

describe('paired scanner staff sessions', () => {
  it('makes wrong, disabled, foreign and missing staff indistinguishable without replacing a binding', async () => {
    const { kit, managerTemplate, session, signIn, binding, staffHash, problem, call, getSession } =
      fixture;
    const current = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      role: 'manager',
      pin: '481926',
    });
    const valid = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '847291' });
    const disabled = await makeScanStaff(kit.fx, {
      orgId: kit.org.id,
      pin: '673829',
      disabled: true,
    });
    const foreignOrg = await makeOrg(kit.fx);
    const foreign = await makeScanStaff(kit.fx, { orgId: foreignOrg.id, pin: '915738' });
    const scanner = await kit.scanner({
      templateIds: [managerTemplate],
      settings: { staffSignIn: true },
    });
    const neighbor = await kit.scanner({
      templateIds: [managerTemplate],
      settings: { staffSignIn: true },
    });
    await session(await signIn(scanner.headers, current), current.pin);
    await session(await signIn(neighbor.headers, valid), valid.pin);
    const original = await binding(scanner.id);
    const other = await binding(neighbor.id);
    const hashes = await Promise.all([current, valid, disabled, foreign].map(staffHash));
    const inputs = [
      { staffId: valid.id, pin: '000000' },
      { staffId: disabled.id, pin: disabled.pin },
      { staffId: foreign.id, pin: foreign.pin },
      { staffId: kit.fx.ids.id(), pin: '294681' },
    ];
    const errors = [];
    for (const input of inputs) {
      errors.push(
        await problem(
          await call('POST', '/scan/staff', scanner.headers, input),
          400,
          'PIN_INVALID',
          input.pin,
          ...hashes,
        ),
      );
      expect(await binding(scanner.id)).toEqual(original);
      expect(await binding(neighbor.id)).toEqual(other);
    }
    expect(errors[0]).toMatchObject({ issues: [{ path: 'triesLeft', message: '4' }] });
    for (const error of errors.slice(1)) expect(error).toEqual(errors[0]);
    expect(
      (await session(await getSession(scanner.headers), current.pin, ...hashes)).staff,
    ).toEqual({
      id: current.id,
      name: current.name,
      role: current.role,
    });
  });

  it('validates PIN shape without consuming attempts or changing the binding', async () => {
    const { kit, deskTemplate, session, signIn, binding, staffHash, problem } = fixture;
    const current = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '162837' });
    const next = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '564738' });
    const scanner = await kit.scanner({
      templateIds: [deskTemplate],
      settings: { staffSignIn: true },
    });
    await session(await signIn(scanner.headers, current), current.pin);
    const original = await binding(scanner.id);
    const hash = await staffHash(next);
    for (const pin of ['12345', '1234567', '12ab34', '', 564738, null]) {
      const failure = await problem(
        await signIn(scanner.headers, next, pin),
        422,
        'VALIDATION',
        next.pin,
        hash,
      );
      expect(failure.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'pin' })]),
      );
      expect(await binding(scanner.id)).toEqual(original);
    }
    const switched = await session(await signIn(scanner.headers, next), next.pin);
    expect(switched.staff).toEqual({ id: next.id, name: next.name, role: next.role });
    expect((await binding(scanner.id)).staffId).toBe(next.id);
  });

  it('locks one person after five misses, including their valid PIN, but not another scanner or person', async () => {
    const { kit, deskTemplate, session, signIn, binding, problem, staffHash } = fixture;
    const current = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '278493' });
    const locked = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '674982' });
    const alternative = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '836251' });
    const scanner = await kit.scanner({
      templateIds: [deskTemplate],
      settings: { staffSignIn: true },
    });
    const other = await kit.scanner({
      templateIds: [deskTemplate],
      settings: { staffSignIn: true },
    });
    await session(await signIn(scanner.headers, current), current.pin);
    const original = await binding(scanner.id);
    for (let i = 0; i < 5; i++) {
      const failure = await problem(
        await signIn(scanner.headers, locked, '000000'),
        400,
        'PIN_INVALID',
      );
      expect(failure.issues).toEqual([{ path: 'triesLeft', message: String(4 - i) }]);
      expect(await binding(scanner.id)).toEqual(original);
    }
    const rateLimited = await signIn(scanner.headers, locked);
    expect(Number(rateLimited.headers.get('retry-after'))).toBeGreaterThan(0);
    await problem(rateLimited, 429, 'RATE_LIMITED', locked.pin, await staffHash(locked));
    expect(await binding(scanner.id)).toEqual(original);
    expect((await session(await signIn(other.headers, locked), locked.pin)).staff?.id).toBe(
      locked.id,
    );
    expect(
      (await session(await signIn(scanner.headers, alternative), alternative.pin)).staff?.id,
    ).toBe(alternative.id);
    expect((await binding(other.id)).staffId).toBe(locked.id);
    kit.clock.advance(5 * 60_000);
    expect((await session(await signIn(scanner.headers, locked), locked.pin)).staff?.id).toBe(
      locked.id,
    );
    expect((await binding(other.id)).staffId).toBe(locked.id);
  });

  it('locks all names after twenty misses on one scanner, not on its neighbor', async () => {
    const { kit, deskTemplate, session, signIn, binding, problem, staffHash } = fixture;
    const current = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '728394' });
    const candidates = await Promise.all(
      ['417628', '617428', '817426', '927416'].map((pin) =>
        makeScanStaff(kit.fx, { orgId: kit.org.id, pin }),
      ),
    );
    const scanner = await kit.scanner({
      templateIds: [deskTemplate],
      settings: { staffSignIn: true },
    });
    const other = await kit.scanner({
      templateIds: [deskTemplate],
      settings: { staffSignIn: true },
    });
    await session(await signIn(scanner.headers, current), current.pin);
    const original = await binding(scanner.id);
    for (const candidate of candidates) {
      for (let i = 0; i < 5; i++) {
        await problem(await signIn(scanner.headers, candidate, '000000'), 400, 'PIN_INVALID');
      }
    }
    const rateLimited = await signIn(scanner.headers, current);
    expect(Number(rateLimited.headers.get('retry-after'))).toBeGreaterThan(0);
    await problem(rateLimited, 429, 'RATE_LIMITED', current.pin, await staffHash(current));
    expect(await binding(scanner.id)).toEqual(original);
    expect((await session(await signIn(other.headers, current), current.pin)).staff?.id).toBe(
      current.id,
    );
    kit.clock.advance(60 * 60_000);
    expect((await session(await signIn(scanner.headers, current), current.pin)).staff?.id).toBe(
      current.id,
    );
  });
});
