import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { recordPassEvent } from '../events/record.ts';
import {
  action,
  type BudgetKit,
  budgetKit,
  hasGate,
  hasReservation,
  outcome,
  scenario,
  withTrace,
} from './action-approval-budget-fixture.ts';
import { counts, seedCounts } from './repo-action-approval-budget-test-fixtures.ts';

let f: BudgetKit;
beforeAll(async () => {
  f = await budgetKit();
});

describe('action approval reservation cleanup', () => {
  it('does not change the budget when required approval is omitted', async () => {
    const { kit } = f;
    const s = await scenario(f);
    await seedCounts(kit, s.scanner.id, s.manager.id, 2, 3);
    const { result, batches } = await withTrace(kit, {}, () => action(kit, s.scanner, s.pass));
    expect(await outcome(result)).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    expect(batches.some(hasReservation)).toBe(false);
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 2, scanner: 3 });
  });

  it('ignores an unneeded approval, including its incorrect PIN', async () => {
    const { kit } = f;
    const s = await scenario(f, f.plainTemplate);
    await seedCounts(kit, s.scanner.id, s.manager.id, 2, 3);
    const { result, batches } = await withTrace(kit, {}, () =>
      action(kit, s.scanner, s.pass, {
        approval: { staffId: s.manager.id, pin: '000000' },
      }),
    );
    const accepted = await outcome(result);
    expect(accepted).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
    expect(
      await first(kit.env.DB, 'SELECT approved_by FROM scans WHERE id=?', [accepted.scanId!]),
    ).toEqual({ approved_by: null });
    expect(batches.some(hasReservation)).toBe(false);
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 2, scanner: 3 });
  });

  it('refunds the valid PIN once on a winning and a genuinely held gate', async () => {
    const { kit } = f;
    const s = await scenario(f);
    await seedCounts(kit, s.scanner.id, s.manager.id, 2, 3);
    const approval = { staffId: s.manager.id, pin: s.manager.pin };
    const firstCall = await withTrace(kit, {}, () => action(kit, s.scanner, s.pass, { approval }));
    const won = await outcome(firstCall.result);
    expect(won).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
    expect(
      await first(kit.env.DB, 'SELECT approved_by FROM scans WHERE id=?', [won.scanId!]),
    ).toEqual({ approved_by: s.manager.id });
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 2, scanner: 3 });

    const secondCall = await withTrace(kit, {}, () => action(kit, s.scanner, s.pass, { approval }));
    expect(await outcome(secondCall.result)).toMatchObject({
      kind: 'heads_up',
      reason: 'already_done',
    });
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 2, scanner: 3 });
  });

  it('refunds once after a real D1 constraint error rolls back the effect', async () => {
    const { kit } = f;
    const s = await scenario(f);
    const other = await kit.scanPass(f.plainTemplate);
    await seedCounts(kit, s.scanner.id, s.manager.id, 2, 3);
    const real = kit.env.DB;
    let collided = false;
    const { result } = await withTrace(
      kit,
      {
        before: async (batch) => {
          if (collided || !hasGate(batch)) return;
          const ledger = batch.find(({ sql }) => /INSERT\s+INTO\s+pass_events\b/i.test(sql));
          const eventId = ledger?.values[0];
          if (typeof eventId !== 'string') throw new Error('Missing pending scan event ID');
          collided = true;
          expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 3, scanner: 4 });
          await recordPassEvent(
            {
              ...kit.ctx,
              env: { ...kit.ctx.env, DB: real },
              ids: { ...kit.ctx.ids, ordered: () => eventId },
            },
            { orgId: kit.org.id, passId: other.id, mode: 'live', kind: 'page.opened' },
          );
          expect(
            await first(real, 'SELECT pass_id FROM pass_events WHERE id=?', [eventId]),
          ).toEqual({ pass_id: other.id });
        },
      },
      () =>
        action(kit, s.scanner, s.pass, {
          approval: { staffId: s.manager.id, pin: s.manager.pin },
        }),
    );
    expect(collided).toBe(true);
    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(
      await first(real, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [s.pass.id]),
    ).toBeNull();
    expect(
      await first(real, "SELECT id FROM scans WHERE pass_id=? AND state='done'", [s.pass.id]),
    ).toBeNull();
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 2, scanner: 3 });
  });

  it('does not refund twice when a committed D1 effect loses its response', async () => {
    const { kit } = f;
    const s = await scenario(f);
    await seedCounts(kit, s.scanner.id, s.manager.id, 2, 3);
    let lost = false;
    const { result } = await withTrace(
      kit,
      {
        after: async (batch) => {
          if (lost || !hasGate(batch)) return;
          lost = true;
          throw new Error('D1 response lost after commit');
        },
      },
      () =>
        action(kit, s.scanner, s.pass, {
          approval: { staffId: s.manager.id, pin: s.manager.pin },
        }),
    );
    expect(lost).toBe(true);
    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(
      await first(kit.env.DB, "SELECT approved_by FROM scans WHERE pass_id=? AND state='done'", [
        s.pass.id,
      ]),
    ).toEqual({ approved_by: s.manager.id });
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 2, scanner: 3 });
  });
});
