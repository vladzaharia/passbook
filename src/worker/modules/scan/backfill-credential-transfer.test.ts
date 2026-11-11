import { expect, it, vi } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { BACKFILL_DONE, backfillScanLookups } from './jobs.ts';
import { makeLegacyScanPass, setupScanKit } from './test-kit.ts';

it.each(['same pass', 'different pass'] as const)(
  'does not backfill credentials after a real transfer starts on a %s',
  async (which) => {
    const kit = await setupScanKit();
    const templateId = await kit.scanTemplate('Backfill transfer fence', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const template = await kit.registry.resolve(templateId);
    const target = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const source =
      which === 'same pass'
        ? target
        : await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const expected = await getHolderPass(kit.env.DB, source.id, null);
    if (!expected) throw new Error('Missing transfer source');
    const real = kit.env.DB;
    const writes = new WeakSet<D1PreparedStatement>();
    let fired = false;
    const db = new Proxy(real, {
      get(targetDb, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = targetDb.prepare(sql);
            if (!sql.startsWith('UPDATE passes SET scan_code')) return prepared;
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = statement.bind(...values);
                    writes.add(bound);
                    return bound;
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const indexes = statements.flatMap((statement, index) =>
              writes.has(statement) ? [index] : [],
            );
            if (!fired && indexes.length) {
              fired = true;
              const transfer = await startCredentialTransfer(
                jobCtxOf(kit),
                { type: 'system', id: null },
                source.id,
                { holderEmail: 'next-holder@example.test', ownerUserId: null },
                null,
                { kind: 'tenant-holder', expected },
              );
              expect(['pending', 'completed']).toContain(transfer.state);
            }
            return targetDb.batch(statements);
          };
        const value = Reflect.get(targetDb, prop, targetDb);
        return typeof value === 'function' ? value.bind(targetDb) : value;
      },
    });
    const job = { ...jobCtxOf(kit), env: { ...kit.env, DB: db } };
    const warn = vi.spyOn(job.log, 'warn');
    await backfillScanLookups(job);
    expect(fired).toBe(true);
    // The transfer bumped the credential generation, so the grant refuses the write.
    expect(warn).toHaveBeenCalledWith(
      'scan.backfill_skip',
      expect.objectContaining({ code: 'SCAN_BACKFILL_REFUSED', passId: source.id }),
    );
    const transfer = await first<{ credential_generation: number }>(
      real,
      'SELECT credential_generation FROM passes WHERE id=?',
      [source.id],
    );
    expect(transfer?.credential_generation).toBe(expected.credentialGeneration + 1);
    if (which === 'different pass') {
      expect(
        await first(real, 'SELECT scan_code, barcode_hash, lookup_hash FROM passes WHERE id=?', [
          target.id,
        ]),
      ).toEqual({ scan_code: null, barcode_hash: null, lookup_hash: null });
      // A later sweep must not restore the other holder's retired Wallet barcode either.
      await backfillScanLookups(jobCtxOf(kit));
      expect(
        await first(real, 'SELECT scan_code, barcode_hash, lookup_hash FROM passes WHERE id=?', [
          target.id,
        ]),
      ).toEqual({ scan_code: null, barcode_hash: null, lookup_hash: null });
    }
  },
);

it('does not mark backfill complete while its only candidate is pending transfer', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Pending backfill', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const template = await kit.registry.resolve(templateId);
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
    id: kit.fx.ids.id(),
    token: kit.fx.ids.token(),
    now: kit.clock.now(),
    targetHolderEmail: 'pending-holder@example.test',
  });
  await backfillScanLookups(jobCtxOf(kit));
  expect(
    await first(kit.env.DB, "SELECT value FROM settings WHERE scope='system' AND key=?", [
      BACKFILL_DONE,
    ]),
  ).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT scan_code, barcode_hash, lookup_hash FROM passes WHERE id=?', [
      pass.id,
    ]),
  ).toEqual({ scan_code: null, barcode_hash: null, lookup_hash: null });
});

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
          if (!sql.startsWith('INSERT INTO settings')) return prepared;
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
