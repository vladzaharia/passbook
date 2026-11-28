import { describe, expect, it } from 'vitest';
import { countD1, makeSession } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { beforeStatement } from './batch-interceptor-test-support.ts';
import { RACE_STAFF_STARTS } from './race-tags.ts';
import { getStaff } from './repo-staff.ts';
import { listStaff, updateStaff } from './staff-admin.ts';
import { setupStaffAdminTestKit } from './staff-admin-test-fixtures.ts';
import { key, codeOf as scanCodeOf, setupScanKit } from './test-kit.ts';

setupStaffAdminTestKit();

describe('mode-specific staff activity and device PIN locks', () => {
  it('shows only a proven, currently safe scanner name for the latest staff scan', async () => {
    const kit = await setupScanKit();
    const template = await kit.scanTemplate('Staff activity', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const person = await kit.staff('manager');
    const scanner = await kit.scanner({
      staffId: person.id,
      templateIds: [template],
      settings: { staffSignIn: true },
    });
    await run(kit.env.DB, "UPDATE scanners SET name = 'North entrance' WHERE id = ?", [scanner.id]);
    const pass = await kit.scanPass(template, {}, { holderEmail: 'private@example.test' });
    const result = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: scanCodeOf(pass),
      actionId: 'check_in',
      clientTs: kit.clock.now(),
    });
    expect(result.status).toBe(200);
    const outcome = (await result.json()) as { kind: string; scanId: string | null };
    expect(outcome.kind).toBe('ok');
    if (!outcome.scanId) throw new Error('Missing scan proof');
    const fixture = await makeSession(kit.fx, { userId: 'admin-1', roles: ['user'] });
    const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
    if (!session) throw new Error('Missing session');
    const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const current = async () =>
      (await listStaff(kit.ctx, session, authority, kit.org.id, 'live')).items.find(
        (item) => item.id === person.id,
      );
    expect((await current())?.lastScan).toMatchObject({ scannerName: 'North entrance' });
    const beforeFinalRead = async (intervene: () => Promise<unknown>) => {
      let intercepted = 0;
      const underlying = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(statement, {
          get(target, prop) {
            if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            const value = Reflect.get(target, prop, target);
            if (prop === 'all')
              return async (...values: unknown[]) => {
                if (!intercepted++) await intervene();
                return (value as (...args: unknown[]) => Promise<unknown>).apply(target, values);
              };
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        underlying.set(proxy, statement);
        return proxy;
      };
      const db = new Proxy(kit.env.DB, {
        get(target, prop) {
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (statements.some((statement) => underlying.has(statement)) && !intercepted++)
                await intervene();
              return target.batch(
                statements.map((statement) => underlying.get(statement) ?? statement),
              );
            };
          if (prop === 'prepare')
            return (sql: string) =>
              sql.includes(RACE_STAFF_STARTS) ? wrap(target.prepare(sql)) : target.prepare(sql);
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const raced = await listStaff(
        { ...kit.ctx, env: { ...kit.env, DB: db } },
        session,
        authority,
        kit.org.id,
        'live',
      );
      expect(intercepted).toBe(1);
      return raced.items.find((item) => item.id === person.id);
    };
    const keyset = await first<{ commitment: string }>(
      kit.env.DB,
      'SELECT commitment FROM credential_ref_keyset WHERE id = 1',
    );
    if (!keyset) throw new Error('Missing credential keyset');
    await run(kit.env.DB, 'DROP TRIGGER credential_ref_keyset_no_update');
    try {
      await expect(
        beforeFinalRead(() =>
          run(kit.env.DB, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
            keyset.commitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
          ]),
        ),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE', status: 503 });
    } finally {
      await run(kit.env.DB, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
        keyset.commitment,
      ]);
      await run(
        kit.env.DB,
        `CREATE TRIGGER credential_ref_keyset_no_update BEFORE UPDATE ON credential_ref_keyset
        BEGIN SELECT RAISE(ABORT, 'credential reference keyset is immutable'); END`,
      );
    }
    const renamed = await beforeFinalRead(() =>
      run(kit.env.DB, "UPDATE scanners SET name = 'private@example.test' WHERE id = ?", [
        scanner.id,
      ]),
    );
    expect(renamed?.lastScan).toMatchObject({ scannerName: 'Scanner' });
    await run(kit.env.DB, "UPDATE scanners SET name = 'North entrance' WHERE id = ?", [scanner.id]);
    const wrongMode = await beforeFinalRead(() =>
      run(kit.env.DB, "UPDATE scanners SET mode = 'test' WHERE id = ?", [scanner.id]),
    );
    expect(wrongMode).toMatchObject({ today: 0, lastScan: null });
    await run(kit.env.DB, "UPDATE scanners SET mode = 'live' WHERE id = ?", [scanner.id]);
    const removed = await beforeFinalRead(() =>
      run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [kit.clock.now(), pass.id]),
    );
    expect(removed).toMatchObject({ today: 1, lastScan: { scannerName: 'Scanner' } });
    await run(kit.env.DB, 'UPDATE passes SET removed_at = NULL WHERE id = ?', [pass.id]);
    const tampered = await beforeFinalRead(() =>
      run(
        kit.env.DB,
        `UPDATE pass_events SET data = json_set(data, '$.outcome', 'refused')
       WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?`,
        [pass.id, outcome.scanId],
      ),
    );
    expect(tampered?.lastScan).toMatchObject({ scannerName: 'Scanner' });
    await run(kit.env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', [
      'North\nentrance',
      scanner.id,
    ]);
    kit.clock.advance(1000);
    const unsafePass = await kit.scanPass(template);
    const unsafe = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: scanCodeOf(unsafePass),
      actionId: 'check_in',
      clientTs: kit.clock.now(),
    });
    expect(unsafe.status).toBe(200);
    const unsafeOutcome = (await unsafe.json()) as { kind: string; scanId: string | null };
    expect(unsafeOutcome.kind).toBe('ok');
    if (!unsafeOutcome.scanId) throw new Error('Missing scan proof');
    expect((await current())?.lastScan).toMatchObject({ scannerName: 'Scanner' });
    await run(kit.env.DB, 'UPDATE scans SET notified = 1, client_ts = ? WHERE id = ?', [
      kit.clock.now() + 30_000,
      unsafeOutcome.scanId,
    ]);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [unsafePass.id]);
    expect(await current()).toMatchObject({ today: 2, lastScan: { scannerName: 'Scanner' } });
    const quarantined = await beforeFinalRead(() =>
      run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]),
    );
    expect(quarantined).toMatchObject({ today: 1, lastScan: { scannerName: 'Scanner' } });
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 0 WHERE id = ?', [pass.id]);
    expect(await current()).toMatchObject({ today: 1, lastScan: { scannerName: 'Scanner' } });
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect(await current()).toMatchObject({ today: 1, lastScan: { scannerName: 'Scanner' } });
  });

  it('reads the roster and every scanner-name proof in one statement', async () => {
    const kit = await setupScanKit();
    const template = await kit.scanTemplate('Paged staff proofs', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const people: Array<{ id: string; scannerName: string; scanId: string; passId: string }> = [];
    for (let index = 0; index < 3; index++) {
      const person = await kit.staff('manager', `Staff ${index}`);
      const scanner = await kit.scanner({
        staffId: person.id,
        templateIds: [template],
        settings: { staffSignIn: true },
      });
      const scannerName = `Entrance ${index}`;
      await run(kit.env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', [scannerName, scanner.id]);
      const pass = await kit.scanPass(template, { memberName: `Member ${index}` });
      const response = await kit.post(scanner.headers, '/actions', {
        idempotencyKey: key(),
        input: scanCodeOf(pass),
        actionId: 'check_in',
        clientTs: kit.clock.now(),
      });
      expect(response.status).toBe(200);
      const outcome = (await response.json()) as { kind: string; scanId: string | null };
      expect(outcome.kind).toBe('ok');
      if (!outcome.scanId) throw new Error('Missing scan proof');
      people.push({ id: person.id, scannerName, scanId: outcome.scanId, passId: pass.id });
    }
    const fixture = await makeSession(kit.fx, { userId: 'admin-1', roles: ['user'] });
    const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
    if (!session) throw new Error('Missing session');
    const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const counted = countD1(kit.env.DB);
    const result = await listStaff(
      { ...kit.ctx, env: { ...kit.env, DB: counted.db } },
      session,
      authority,
      kit.org.id,
      'live',
    );
    for (const person of people) {
      expect(result.items.find((item) => item.id === person.id)).toMatchObject({
        today: 1,
        lastScan: { scannerName: person.scannerName },
      });
    }
    // Zones, the roster with every name proof, then the manifests and keyset: no statement per person.
    const statements = counted.sql();
    const roster = statements.findIndex((sql) => sql.includes(RACE_STAFF_STARTS));
    expect(statements.filter((sql) => sql.includes(RACE_STAFF_STARTS))).toHaveLength(1);
    // After the roster only the manifests and the keyset pin are read, together.
    expect(statements.length - roster - 1).toBeLessThanOrEqual(2);

    // One person's event is tampered with: only that person's scanner name falls back.
    const [tampered] = people;
    if (!tampered) throw new Error('Missing person');
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data = json_set(data, '$.outcome', 'refused')
       WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?`,
      [tampered.passId, tampered.scanId],
    );
    const stale = await listStaff(kit.ctx, session, authority, kit.org.id, 'live');
    for (const person of people) {
      expect(stale.items.find((item) => item.id === person.id)).toMatchObject({
        today: 1,
        lastScan: { scannerName: person.id === tampered.id ? 'Scanner' : person.scannerName },
      });
    }
  });

  it('refuses a roster whose scanner time zones changed since they were read', async () => {
    const kit = await setupScanKit();
    const template = await kit.scanTemplate('Zone staff', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const person = await kit.staff('manager', 'Zoned');
    const scanner = await kit.scanner({ staffId: person.id, templateIds: [template] });
    const fixture = await makeSession(kit.fx, { userId: 'admin-1', roles: ['user'] });
    const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
    if (!session) throw new Error('Missing session');
    const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const { fired, result } = await beforeStatement(
      kit.ctx.env,
      RACE_STAFF_STARTS,
      () =>
        run(kit.env.DB, "UPDATE scanners SET time_zone = 'Pacific/Auckland' WHERE id = ?", [
          scanner.id,
        ]),
      () =>
        listStaff(kit.ctx, session, authority, kit.org.id, 'live').then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(fired).toBe(true);
    expect(result).toMatchObject({ status: 409, code: 'SCAN_STAFF_CHANGED' });
    const manage = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:manage');
    if (manage.kind !== 'session') throw new Error('Expected session authority');
    const observed = await getStaff(kit.env.DB, kit.org.id, person.id);
    if (!observed) throw new Error('Missing staff');
    // The edit committed; an activity read that cannot be verified never fails it. The answer is the
    // plain account, with no activity.
    const updated = await beforeStatement(
      kit.ctx.env,
      RACE_STAFF_STARTS,
      () =>
        run(kit.env.DB, "UPDATE scanners SET time_zone = 'Asia/Tokyo' WHERE id = ?", [scanner.id]),
      () => updateStaff(kit.ctx, session, manage, observed, 'live', { role: 'desk' }),
    );
    expect(updated.result).toMatchObject({ id: person.id, role: 'desk', today: 0, lastScan: null });
  });
});
