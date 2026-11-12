import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { all, first } from '../../platform/db.ts';
import { clearSettingsCache } from '../settings/service.ts';
import {
  action,
  type BudgetKit,
  budgetKit,
  scenario,
  traceD1,
} from './action-approval-budget-fixture.ts';
import { counts, seedCounts } from './repo-action-approval-budget-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: BudgetKit;
beforeAll(async () => {
  f = await budgetKit();
});

describe('concurrent action PIN guesses', () => {
  it('admits only five wrong guesses for one person and records one lock audit', async () => {
    const { kit } = f;
    const s = await scenario(f);
    const keys = Array.from({ length: 12 }, () => key());
    const replies = await Promise.all(
      keys.map((idempotencyKey) =>
        action(kit, s.scanner, s.pass, {
          idempotencyKey,
          approval: { staffId: s.manager.id, pin: '000000' },
        }),
      ),
    );
    expect(replies.filter((response) => response.status === 400)).toHaveLength(5);
    expect(replies.filter((response) => response.status === 429)).toHaveLength(7);
    const bodies = await Promise.all(
      replies.map((response) => response.json() as Promise<{ code: string }>),
    );
    expect(bodies.filter((body) => body.code === 'PIN_INVALID')).toHaveLength(5);
    expect(bodies.filter((body) => body.code === 'RATE_LIMITED')).toHaveLength(7);
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 5, scanner: 5 });
    expect(
      await all(
        kit.env.DB,
        "SELECT action,actor_type,actor_id,target_id FROM audit_log WHERE action='scan_staff.pin_locked' AND target_id=?",
        [s.manager.id],
      ),
    ).toEqual([
      {
        action: 'scan_staff.pin_locked',
        actor_type: 'scanner',
        actor_id: s.scanner.id,
        target_id: s.manager.id,
      },
    ]);
    expect(
      await first(
        kit.env.DB,
        "SELECT count(*) AS n FROM scans WHERE scanner_id=? AND state='failed'",
        [s.scanner.id],
      ),
    ).toEqual({ n: 12 });
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [s.pass.id]),
    ).toBeNull();
  }, 120_000);

  it('admits only twenty wrong guesses across distinct people and compensates denied reservations', async () => {
    const { kit } = f;
    const s = await scenario(f);
    const managers = await Promise.all(Array.from({ length: 24 }, () => kit.staff('manager')));
    const replies = await Promise.all(
      managers.map((manager) =>
        action(kit, s.scanner, s.pass, {
          approval: { staffId: manager.id, pin: '000000' },
        }),
      ),
    );
    expect(replies.filter((response) => response.status === 400)).toHaveLength(20);
    expect(replies.filter((response) => response.status === 429)).toHaveLength(4);
    const values = await all<{ count: number }>(
      kit.env.DB,
      'SELECT count FROM counters WHERE key LIKE ?',
      [`scan:pin:${s.scanner.id}:%`],
    );
    expect(values.filter((row) => row.count === 1)).toHaveLength(20);
    expect(values.filter((row) => row.count === 0)).toHaveLength(4);
    expect((await counts(kit, s.scanner.id, s.manager.id)).scanner).toBe(20);
    expect(
      await all(
        kit.env.DB,
        "SELECT action,actor_type,actor_id,target_id FROM audit_log WHERE action='scanner.pin_flood' AND target_id=?",
        [s.scanner.id],
      ),
    ).toEqual([
      {
        action: 'scanner.pin_flood',
        actor_type: 'scanner',
        actor_id: s.scanner.id,
        target_id: s.scanner.id,
      },
    ]);
    expect(
      await first(
        kit.env.DB,
        "SELECT count(*) AS n FROM scans WHERE scanner_id=? AND state='failed'",
        [s.scanner.id],
      ),
    ).toEqual({ n: 24 });
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [s.pass.id]),
    ).toBeNull();
  }, 120_000);

  it('commits both threshold audits and the failed claim in the same bounded request', async () => {
    const { kit } = f;
    const s = await scenario(f);
    await seedCounts(kit, s.scanner.id, s.manager.id, 4, 19);
    const idempotencyKey = key();
    const real = kit.env.DB;
    const counted = countD1(real);
    const trace = traceD1(counted.db);
    Object.assign(kit.env, { DB: trace.db });
    try {
      await kit.post(s.scanner.headers, '/actions', {});
      const guard = counted.count();
      counted.reset();
      trace.batches.length = 0;
      clearSettingsCache(trace.db);
      const response = await action(kit, s.scanner, s.pass, {
        idempotencyKey,
        approval: { staffId: s.manager.id, pin: '000000' },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'PIN_INVALID',
        issues: [{ path: 'triesLeft', message: '0' }],
      });
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
      const failureBatch = trace.batches.find(
        (batch) =>
          batch.some(({ sql }) => /UPDATE\s+scans\s+SET\s+state\s*=\s*'failed'/i.test(sql)) &&
          batch.filter(({ sql }) => /INSERT\s+INTO\s+audit_log/i.test(sql)).length === 2,
      );
      expect(failureBatch).toBeDefined();
    } finally {
      Object.assign(kit.env, { DB: real });
    }
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 5, scanner: 20 });
    expect(
      await first(real, 'SELECT state FROM scans WHERE idempotency_key=?', [idempotencyKey]),
    ).toEqual({ state: 'failed' });
    expect(
      await all(
        real,
        "SELECT action FROM audit_log WHERE actor_id=? AND action IN ('scan_staff.pin_locked','scanner.pin_flood') ORDER BY action",
        [s.scanner.id],
      ),
    ).toEqual([{ action: 'scan_staff.pin_locked' }, { action: 'scanner.pin_flood' }]);
    const limited = await action(kit, s.scanner, s.pass, {
      approval: { staffId: s.manager.id, pin: s.manager.pin },
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 5, scanner: 20 });
    expect(
      await all(
        real,
        "SELECT action FROM audit_log WHERE actor_id=? AND action IN ('scan_staff.pin_locked','scanner.pin_flood')",
        [s.scanner.id],
      ),
    ).toHaveLength(2);
  });
});
