import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
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
import { counts, effects, seedCounts } from './repo-action-approval-budget-test-fixtures.ts';
import { hashPin } from './staff-pin.ts';
import { key } from './test-kit.ts';

let f: BudgetKit;
beforeAll(async () => {
  f = await budgetKit();
});

describe('action approval authority and reservations', () => {
  it.each(['demoted', 'disabled', 'pin rotated'] as const)(
    'rejects a manager %s after PIN verification and refunds the reservation',
    async (change) => {
      const { kit } = f;
      const s = await scenario(f);
      await seedCounts(kit, s.scanner.id, s.manager.id, 2, 3);
      const before = await effects(kit, s.pass.id);
      const replacementHash = await hashPin(kit.env, s.manager.id, '654321');
      const real = kit.env.DB;
      let raced = false;
      const { result } = await withTrace(
        kit,
        {
          before: async (batch) => {
            if (raced || !hasGate(batch)) return;
            raced = true;
            expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({
              person: 3,
              scanner: 4,
            });
            if (change === 'demoted')
              await run(real, "UPDATE scan_staff SET role='door' WHERE id=?", [s.manager.id]);
            else if (change === 'disabled')
              await run(real, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
                kit.clock.now(),
                s.manager.id,
              ]);
            else
              await run(real, 'UPDATE scan_staff SET pin_hash=? WHERE id=?', [
                replacementHash,
                s.manager.id,
              ]);
          },
        },
        () =>
          action(kit, s.scanner, s.pass, {
            approval: { staffId: s.manager.id, pin: s.manager.pin },
          }),
      );
      expect(raced).toBe(true);
      // The staff row's auth_epoch moved, so the grant refuses the ticket with a classified 409.
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ code: 'SCAN_STAFF_CHANGED' });
      expect(await effects(kit, s.pass.id)).toEqual(before);
      expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 2, scanner: 3 });
    },
  );

  it('checks the manager row captured with the claim, not a newly rotated PIN', async () => {
    const { kit } = f;
    const s = await scenario(f);
    const before = await effects(kit, s.pass.id);
    const replacement = '654321';
    const hash = await hashPin(kit.env, s.manager.id, replacement);
    const real = kit.env.DB;
    let raced = false;
    const { result } = await withTrace(
      kit,
      {
        before: async (batch) => {
          if (raced || !hasReservation(batch)) return;
          raced = true;
          await run(real, 'UPDATE scan_staff SET pin_hash=? WHERE id=?', [hash, s.manager.id]);
        },
      },
      () =>
        action(kit, s.scanner, s.pass, {
          approval: { staffId: s.manager.id, pin: replacement },
        }),
    );
    expect(raced).toBe(true);
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: 'PIN_INVALID' });
    expect(await effects(kit, s.pass.id)).toEqual(before);
    expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 1, scanner: 1 });
  });

  it.each(['scanner revoked', 'scanner csrf rotated', 'claim replaced', 'nothing'] as const)(
    'does not spend a guess after the original %s before reservation',
    async (change) => {
      const { kit } = f;
      const s = await scenario(f);
      const idempotencyKey = key();
      const real = kit.env.DB;
      let raced = false;
      const { result } = await withTrace(
        kit,
        {
          before: async (batch) => {
            if (raced || !hasReservation(batch)) return;
            raced = true;
            if (change === 'scanner revoked') {
              await run(real, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
                kit.clock.now(),
                s.scanner.id,
              ]);
            } else if (change === 'scanner csrf rotated') {
              await run(
                real,
                'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
                [kit.fx.ids.token(), s.scanner.id],
              );
            } else if (change === 'claim replaced') {
              expect(
                await run(
                  real,
                  "UPDATE scans SET state='failed' WHERE actor_key=? AND idempotency_key=? AND state='pending'",
                  [`s:${s.scanner.id}`, idempotencyKey],
                ),
              ).toEqual({ changes: 1 });
            }
          },
        },
        () =>
          action(kit, s.scanner, s.pass, {
            idempotencyKey,
            approval: { staffId: s.manager.id, pin: s.manager.pin },
          }),
      );
      expect(raced).toBe(true);
      if (change === 'nothing') {
        // The same approved request with nothing changed is admitted and the valid PIN refunded.
        expect(await outcome(result)).toMatchObject({ kind: 'ok' });
        expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 0, scanner: 0 });
        return;
      }
      if (change === 'claim replaced')
        expect(await outcome(result)).toMatchObject({
          kind: 'refused',
          reason: 'not_found',
          scanId: null,
        });
      else {
        // A revoked or replaced scanner credential unpairs the device rather than answering a miss.
        expect(result.status).toBe(401);
        expect(await result.json()).toMatchObject({ code: 'SCANNER_REPAIR' });
      }
      expect(await counts(kit, s.scanner.id, s.manager.id)).toEqual({ person: 0, scanner: 0 });
      expect(
        await first(real, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [s.pass.id]),
      ).toBeNull();
    },
  );
});
