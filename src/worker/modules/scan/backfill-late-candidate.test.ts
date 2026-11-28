import { expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { BACKFILL_DONE, backfillScanLookups } from './jobs.ts';
import { RACE_BACKFILL_DONE_WRITE } from './race-tags.ts';
import { makeLegacyScanPass, setupScanKit } from './test-kit.ts';

// Own file: the shared test database must hold no unkeyed pass left by another test.
it('does not mark backfill complete when a candidate arrives after the empty read', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Late backfill candidate', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const template = await kit.registry.resolve(templateId);
  const real = kit.env.DB;
  const race: { pass?: { id: string } } = {};
  const completion = new WeakSet<D1PreparedStatement>();
  const db = new Proxy(real, {
    get(targetDb, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = targetDb.prepare(sql);
          if (!sql.includes(RACE_BACKFILL_DONE_WRITE)) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  completion.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!race.pass && statements.some((statement) => completion.has(statement)))
            race.pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
          return targetDb.batch(statements);
        };
      const value = Reflect.get(targetDb, prop, targetDb);
      return typeof value === 'function' ? value.bind(targetDb) : value;
    },
  });
  await backfillScanLookups({ ...jobCtxOf(kit), env: { ...kit.env, DB: db } });
  expect(race.pass).toBeDefined();
  expect(
    await first(real, "SELECT value FROM settings WHERE scope='system' AND key=?", [BACKFILL_DONE]),
  ).toBeNull();
  if (!race.pass) throw new Error('Missing interleaved pass');
  const passId = race.pass.id;
  expect(await first(real, 'SELECT scan_code FROM passes WHERE id=?', [passId])).toEqual({
    scan_code: null,
  });
  await backfillScanLookups(jobCtxOf(kit));
  const row = await first<{ scan_code: string | null }>(
    real,
    'SELECT scan_code FROM passes WHERE id=?',
    [passId],
  );
  expect(row?.scan_code).toMatch(/^[A-Z2-7]{26}$/);
});
