import { expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { cronWithInterleave, stage } from './act-recovery-test-fixtures.ts';
import { act, expectUnavailable, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { reconcileScans } from './jobs.ts';
import { recoverScans } from './recover.ts';
import { scanByKey } from './repo-scans.ts';
import { codeOf, key } from './test-kit.ts';

export function registerRecoveryRaces() {
  it('fences an old in-flight gate attempt while its pristine claim is retried', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = kit.env.DB;
    // The worker targets ES2023; its test runtime provides Promise.withResolvers.
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const oldEntered = deferred.withResolvers<void>();
    const newEntered = deferred.withResolvers<void>();
    const oldResume = deferred.withResolvers<void>();
    const newResume = deferred.withResolvers<void>();
    const gateStatements = new WeakSet<D1PreparedStatement>();
    let gateBatches = 0;
    const db = new Proxy(original, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            if (!sql.includes('INSERT INTO scan_gates')) return prepared;
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...params: unknown[]) => {
                    const bound = statement.bind(...params);
                    gateStatements.add(bound);
                    return bound;
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (statements.some((statement) => gateStatements.has(statement))) {
              const generation = ++gateBatches;
              if (generation === 1) {
                oldEntered.resolve();
                await oldResume.promise;
              } else if (generation === 2) {
                newEntered.resolve();
                await newResume.promise;
              }
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    const firstRequest = act(scanner.headers, codeOf(pass), { idempotencyKey });
    let retry: Promise<Response> | undefined;
    try {
      await Promise.race([
        oldEntered.promise,
        firstRequest.then(() => {
          throw new Error('first attempt did not reach the gate');
        }),
      ]);
      const firstClaim = await first<{ id: string; at: number }>(
        original,
        'SELECT id, at FROM scans WHERE idempotency_key = ?',
        [idempotencyKey],
      );
      expect(firstClaim).not.toBeNull();
      if (!firstClaim) throw new Error('Missing first scan claim');
      kit.clock.advance(20_000);
      retry = act(scanner.headers, codeOf(pass), { idempotencyKey });
      await Promise.race([
        newEntered.promise,
        retry.then(() => {
          throw new Error('retry did not reach the gate');
        }),
      ]);
      const reopened = await first<{ id: string; state: string; at: number }>(
        original,
        'SELECT id, state, at FROM scans WHERE idempotency_key = ?',
        [idempotencyKey],
      );
      expect(reopened).toEqual({ id: firstClaim.id, state: 'pending', at: kit.clock.now() });
      if (!reopened) throw new Error('Missing reopened scan claim');
      oldResume.resolve();
      // The retry owns the claim now: the old attempt's commit is refused as superseded.
      const superseded = await firstRequest;
      expect(superseded.status).toBe(409);
      expect(await superseded.json()).toMatchObject({ code: 'SCAN_IN_PROGRESS' });
      expect(
        await first(original, 'SELECT state, reason, at FROM scans WHERE id = ?', [firstClaim.id]),
      ).toEqual({ state: 'pending', reason: null, at: reopened.at });
      expect(
        await all(original, 'SELECT pass_id FROM scan_gates WHERE pass_id = ?', [pass.id]),
      ).toHaveLength(0);
      expect(
        await all(original, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
          pass.id,
        ]),
      ).toHaveLength(0);
      newResume.resolve();
      expect(await out(await retry)).toMatchObject({
        kind: 'ok',
        replay: false,
        scanId: firstClaim.id,
      });
    } finally {
      oldResume.resolve();
      newResume.resolve();
      await Promise.allSettled([firstRequest, ...(retry !== undefined ? [retry] : [])]);
      Object.assign(kit.env, { DB: original });
    }
    expect(gateBatches).toBe(2);
    expect(
      await all(
        original,
        "SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'",
        [pass.id],
      ),
    ).toHaveLength(1);
  });

  // The reopen is part of the claim grant now, so there is no window between the failed-row read and
  // the reopen to hook: a stale (non-retryable) marker must already refuse the retry.
  it('does not reopen a failed claim that carries the stale marker', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(s, pass, key());
    const claimed = await scanByKey(kit.env.DB, `s:${s.id}`, req.idempotencyKey);
    if (!claimed) throw new Error('Missing staged scan claim');
    await run(kit.env.DB, "UPDATE scans SET state = 'failed', reason = 'stale' WHERE id = ?", [
      claimed.id,
    ]);
    expectUnavailable(
      await out(await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey })),
    );
    expect(
      await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [claimed.id]),
    ).toEqual({ state: 'failed', reason: 'stale' });
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });

  it('does not undo quarantine when cron recovers before an older retry snapshot', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(s, pass, key());
    const claimed = await scanByKey(kit.env.DB, `s:${s.id}`, req.idempotencyKey);
    if (!claimed) throw new Error('Missing staged scan claim');
    await run(
      kit.env.DB,
      `INSERT INTO scan_gates
      (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
      VALUES (?, 'check_in', '', ?, 'live', ?, 'check_in', 'in', 1, ?, ?, ?)`,
      [pass.id, kit.org.id, tpl, kit.clock.now(), kit.clock.now(), claimed.id],
    );
    kit.clock.advance(61_000);
    const ctx = createServiceContext(kit.env, { clock: kit.clock });
    await reconcileScans(ctx);
    await recoverScans(ctx, [claimed]);
    expectUnavailable(
      await out(await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey })),
    );
    expect(
      await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [claimed.id]),
    ).toEqual({ state: 'failed', reason: 'stale' });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [pass.id]),
    ).toHaveLength(0);
  });

  it('does not undo quarantine when retry recovers during a cron recovery', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(s, pass, key());
    const claimed = await scanByKey(kit.env.DB, `s:${s.id}`, req.idempotencyKey);
    if (!claimed) throw new Error('Missing staged scan claim');
    await run(
      kit.env.DB,
      `INSERT INTO scan_gates
      (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
      VALUES (?, 'check_in', '', ?, 'live', ?, 'check_in', 'in', 1, ?, ?, ?)`,
      [pass.id, kit.org.id, tpl, kit.clock.now(), kit.clock.now(), claimed.id],
    );
    kit.clock.advance(61_000);
    let retry: ScanOutcome | undefined;
    await cronWithInterleave(async () => {
      retry = await out(await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey }));
    });
    expect(retry).toBeDefined();
    if (retry === undefined) throw new Error('Missing interleaved retry outcome');
    expectUnavailable(retry);
    expectUnavailable(
      await out(await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey })),
    );
    expect(
      await first(kit.env.DB, 'SELECT state, outcome, reason FROM scans WHERE id = ?', [
        claimed.id,
      ]),
    ).toEqual({ state: 'failed', outcome: null, reason: 'stale' });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [pass.id]),
    ).toHaveLength(0);
  });

  it('preserves a successful pristine retry that finishes during cron recovery', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(s, pass, key());
    const claimed = await scanByKey(kit.env.DB, `s:${s.id}`, req.idempotencyKey);
    if (!claimed) throw new Error('Missing staged scan claim');
    kit.clock.advance(61_000);
    let retry: ScanOutcome | undefined;
    await cronWithInterleave(async () => {
      retry = await out(await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey }));
    });
    expect(retry).toMatchObject({ kind: 'ok', replay: false, scanId: claimed.id });
    expect(
      await first(kit.env.DB, 'SELECT state, outcome, reason FROM scans WHERE id = ?', [
        claimed.id,
      ]),
    ).toEqual({ state: 'done', outcome: 'ok', reason: null });
    expect(
      await first(kit.env.DB, 'SELECT last_scan_id, count FROM scan_gates WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toEqual({ last_scan_id: claimed.id, count: 1 });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'", [
        pass.id,
      ]),
    ).toHaveLength(1);
  });
}
