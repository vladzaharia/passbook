import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { type makeEnv, makeScanner, makeScanStaff } from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, run } from '../../platform/db.ts';
import { code, createGuardHarness, get } from './guard-test-fixtures.ts';

const harness = createGuardHarness();
let { f, clock, orgId } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, orgId } = harness);
  return result;
};

describe('requireScanActor: staff binding', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  it('sign-in on and nobody bound gives 403 STAFF_REQUIRED, except on the exempt routes', async () => {
    const s = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const res = await get(app, env, '/ping', s.headers);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('STAFF_REQUIRED');
    const exempt = await get(app, env, '/session', s.headers);
    expect(exempt.status).toBe(200);
    expect(await exempt.json()).toMatchObject({ role: null });
  });

  it('a bound staff member sets the role', async () => {
    const staff = await makeScanStaff(f, { orgId, role: 'desk' });
    const s = await makeScanner(f, { orgId, settings: { staffSignIn: true }, staffId: staff.id });
    expect(await (await get(app, env, '/ping', s.headers)).json()).toMatchObject({
      role: 'desk',
      staff: staff.name,
    });
  });

  it('the binding ends at 15 minutes idle', async () => {
    const staff = await makeScanStaff(f, { orgId, role: 'desk' });
    const s = await makeScanner(f, {
      orgId,
      settings: { staffSignIn: true },
      staffId: staff.id,
      staffSeenAt: clock.now() - 16 * 60_000,
    });
    expect(await code(await get(app, env, '/ping', s.headers))).toBe('STAFF_REQUIRED');
    const rows = await all<{ staff_id: string | null }>(
      env.DB,
      'SELECT staff_id FROM scanners WHERE id = ?',
      [s.id],
    );
    expect(rows[0]?.staff_id).toBeNull();
  });

  it('the binding ends at 12 hours, and when the person is disabled', async () => {
    const staff = await makeScanStaff(f, { orgId, role: 'desk' });
    const old = await makeScanner(f, {
      orgId,
      settings: { staffSignIn: true },
      staffId: staff.id,
      staffSince: clock.now() - 13 * 3_600_000,
    });
    expect(await code(await get(app, env, '/ping', old.headers))).toBe('STAFF_REQUIRED');
    const gone = await makeScanStaff(f, { orgId, role: 'desk', disabled: true });
    const s = await makeScanner(f, { orgId, settings: { staffSignIn: true }, staffId: gone.id });
    expect(await code(await get(app, env, '/ping', s.headers))).toBe('STAFF_REQUIRED');
  });

  it('clears a retained manager binding when staff sign-in is disabled', async () => {
    const manager = await makeScanStaff(f, { orgId, role: 'manager' });
    const s = await makeScanner(f, {
      orgId,
      settings: { staffSignIn: false, roleWithoutSignIn: 'door' },
      staffId: manager.id,
    });
    const response = await get(app, env, '/ping', s.headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ role: 'door', staff: null });
    const rows = await all<{
      staff_id: string | null;
      staff_since: number | null;
      staff_seen_at: number | null;
    }>(env.DB, 'SELECT staff_id, staff_since, staff_seen_at FROM scanners WHERE id = ?', [s.id]);
    expect(rows[0]).toEqual({ staff_id: null, staff_since: null, staff_seen_at: null });
  });

  it.each(['retained', 'expired', 'disabled'] as const)(
    'keeps actor authority current after clearing a %s staff binding',
    async (kind) => {
      const staff = await makeScanStaff(f, {
        orgId,
        role: 'manager',
        disabled: kind === 'disabled',
      });
      const scanner = await makeScanner(f, {
        orgId,
        settings: { staffSignIn: false, roleWithoutSignIn: 'door' },
        staffId: staff.id,
        ...(kind === 'expired' ? { staffSeenAt: clock.now() - 16 * 60_000 } : {}),
      });
      const before = await all<{ updated_at: number }>(
        env.DB,
        'SELECT updated_at FROM scanners WHERE id = ?',
        [scanner.id],
      );
      const response = await get(app, env, '/authority', scanner.headers);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ current: true });
      const after = await all<{ updated_at: number; staff_id: string | null }>(
        env.DB,
        'SELECT updated_at, staff_id FROM scanners WHERE id = ?',
        [scanner.id],
      );
      expect(after[0]).toEqual({ updated_at: (before[0]?.updated_at ?? 0) + 1, staff_id: null });
    },
  );

  it('does not bless a concurrent scanner configuration change while clearing staff', async () => {
    const staff = await makeScanStaff(f, { orgId, role: 'manager' });
    const scanner = await makeScanner(f, {
      orgId,
      settings: { staffSignIn: false, roleWithoutSignIn: 'door' },
      staffId: staff.id,
    });
    const original = env.DB;
    let raced = false;
    // The clear is one grant batch. A settings edit lands just before it: ending the binding still
    // commits (it only reduces access), but the actor was derived from the old settings, so it is
    // not current.
    const intercepted = new Proxy(original, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!raced && marked.length > 0) {
              raced = true;
              await run(
                original,
                "UPDATE scanners SET settings = json_set(settings, '$.lookup', json('false')) WHERE id = ?",
                [scanner.id],
              );
            }
            return target.batch(statements);
          };
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (/UPDATE\s+scanners\s+SET\s+staff_id\s*=\s*\?/i.test(sql)) marked.push(statement);
            return statement;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const marked: D1PreparedStatement[] = [];
    Object.assign(env, { DB: intercepted });
    try {
      const response = await get(app, env, '/authority', scanner.headers);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ current: false });
      expect(raced).toBe(true);
    } finally {
      Object.assign(env, { DB: original });
    }
    const rows = await all<{ staff_id: string | null }>(
      env.DB,
      'SELECT staff_id FROM scanners WHERE id = ?',
      [scanner.id],
    );
    expect(rows[0]?.staff_id).toBeNull();
  });

  it('without sign-in the role is roleWithoutSignIn; a terminal never needs staff', async () => {
    const desk = await makeScanner(f, { orgId, settings: { roleWithoutSignIn: 'desk' } });
    expect(await (await get(app, env, '/ping', desk.headers)).json()).toMatchObject({
      role: 'desk',
    });
    const t = await makeScanner(f, { orgId, kind: 'terminal', settings: { staffSignIn: true } });
    expect(await (await get(app, env, '/ping', t.headers)).json()).toMatchObject({ role: 'door' });
  });
});
