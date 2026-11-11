import { expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { raceGate } from './act-authority-test-fixtures.ts';
import { act, expectUnavailable, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { reconcileScans } from './jobs.ts';
import { commitBatchSql } from './repo-act-support-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerAuthorityGates() {
  it('does not treat a stale same-scan gate as a new authorized admission', async () => {
    const s = await kit.scanner({
      templateIds: [tpl],
      settings: { checkIn: { mode: 'in_out' } },
    });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    let pendingId = '';
    const response = await raceGate(
      s.headers,
      codeOf(pass),
      async (db) => {
        const pending = await first<{ id: string }>(
          db,
          'SELECT id FROM scans WHERE idempotency_key=? AND state=?',
          [idempotencyKey, 'pending'],
        );
        if (!pending) throw new Error('pending scan not found');
        pendingId = pending.id;
        await run(
          db,
          `INSERT INTO scan_gates
        (pass_id,action_id,scope,org_id,mode,template_id,kind,state,count,first_at,last_at,last_scan_id)
        VALUES (?,'check_in','',?,'live',?,'check_in','in',1,?,?,?)`,
          [pass.id, kit.org.id, tpl, kit.clock.now(), kit.clock.now(), pending.id],
        );
        await run(db, "UPDATE scanners SET device_role='monitor' WHERE id=?", [s.id]);
      },
      { idempotencyKey },
    );
    // The scanner's role moved: a classified 409, not a masked miss. The claim is released unfinished.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
    expect(
      await first<{ state: string; outcome: string | null }>(
        kit.env.DB,
        'SELECT state,outcome FROM scans WHERE id=?',
        [pendingId],
      ),
    ).toEqual({ state: 'failed', outcome: null });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'", [
        pass.id,
      ]),
    ).toHaveLength(0);
    expect(await rows('SELECT pass_id FROM scan_presence WHERE pass_id=?', [pass.id])).toHaveLength(
      0,
    );
    expect(
      await first<{ count: number; last_scan_id: string }>(
        kit.env.DB,
        'SELECT count,last_scan_id FROM scan_gates WHERE pass_id=?',
        [pass.id],
      ),
    ).toEqual({ count: 1, last_scan_id: pendingId });
  });

  it('finishes once when a gate row already names this pending scan', async () => {
    const s = await kit.scanner({ templateIds: [tpl], settings: { checkIn: { mode: 'in_out' } } });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    let pendingId = '';
    const response = await raceGate(
      s.headers,
      codeOf(pass),
      async (db) => {
        const pending = await first<{ id: string }>(
          db,
          "SELECT id FROM scans WHERE idempotency_key=? AND state='pending'",
          [idempotencyKey],
        );
        if (!pending) throw new Error('pending scan not found');
        pendingId = pending.id;
        await run(
          db,
          `INSERT INTO scan_gates
        (pass_id,action_id,scope,org_id,mode,template_id,kind,state,count,first_at,last_at,last_scan_id)
        VALUES (?,'check_in','',?,'live',?,'check_in','in',1,?,?,?)`,
          [pass.id, kit.org.id, tpl, kit.clock.now(), kit.clock.now(), pending.id],
        );
      },
      { idempotencyKey },
    );
    // A gate row naming this very scan is its own earlier effect, not a rival: the commit is
    // idempotent on it and records exactly one visit.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'ok', scanId: pendingId });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'", [
        pass.id,
      ]),
    ).toHaveLength(1);
    expect(
      await first<{ state: string; outcome: string | null }>(
        kit.env.DB,
        'SELECT state,outcome FROM scans WHERE id=?',
        [pendingId],
      ),
    ).toEqual({ state: 'done', outcome: 'ok' });
  });

  it('finishes once when an in-flight scan races a cron recovery', async () => {
    const s = await kit.scanner({ templateIds: [tpl], settings: { checkIn: { mode: 'in_out' } } });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = kit.env.DB;
    const gateStatements = new WeakSet<D1PreparedStatement>();
    let pendingId = '';
    // The worker targets ES2023; its test runtime provides Promise.withResolvers.
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const paused = deferred.withResolvers<void>();
    const resumed = deferred.withResolvers<void>();
    let gated = false;
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
            if (!gated && statements.some((statement) => gateStatements.has(statement))) {
              gated = true;
              const pending = await first<{ id: string }>(
                target,
                "SELECT id FROM scans WHERE idempotency_key = ? AND state = 'pending'",
                [idempotencyKey],
              );
              if (!pending) throw new Error('pending scan not found');
              pendingId = pending.id;
              await run(
                target,
                `INSERT INTO scan_gates
              (pass_id,action_id,scope,org_id,mode,template_id,kind,state,count,first_at,last_at,last_scan_id)
              VALUES (?,'check_in','',?,'live',?,'check_in','in',1,?,?,?)`,
                [pass.id, kit.org.id, tpl, kit.clock.now(), kit.clock.now(), pendingId],
              );
              kit.clock.advance(61_000);
              paused.resolve();
              await resumed.promise;
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    const request = act(s.headers, codeOf(pass), { idempotencyKey });
    try {
      await Promise.race([
        paused.promise,
        request.then(() => {
          throw new Error('request did not reach the gate batch');
        }),
      ]);
      let batches = 0;
      const cronDb = new Proxy(original, {
        get(target, prop) {
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (++batches === 2) {
                resumed.resolve();
                await request;
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const env = { ...kit.env, DB: cronDb };
      await reconcileScans(createServiceContext(env, { clock: kit.clock }));
      expect(batches).toBe(2);
      expect(await out(await request)).toMatchObject({ kind: 'ok', scanId: pendingId });
    } finally {
      resumed.resolve();
      Object.assign(kit.env, { DB: original });
    }
    // Recovery sees a gate that names the in-flight scan and leaves it alone; the request finishes
    // once, and the row, the gate and the ledger agree.
    expect(
      await first(original, 'SELECT state, outcome, reason FROM scans WHERE id = ?', [pendingId]),
    ).toEqual({ state: 'done', outcome: 'ok', reason: null });
    expect(
      await first(original, 'SELECT last_scan_id FROM scan_gates WHERE pass_id = ?', [pass.id]),
    ).toEqual({ last_scan_id: pendingId });
    expect(
      await all(original, "SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(1);
  });

  it('records a heads-up once when the gate time moves after it was read', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    expect((await out(await act(s.headers, codeOf(pass)))).kind).toBe('ok');
    const response = await raceGate(
      s.headers,
      codeOf(pass),
      (db) => run(db, 'UPDATE scan_gates SET last_at=last_at+1 WHERE pass_id=?', [pass.id]),
      {},
      commitBatchSql,
    );
    // The gate's last_at is a volatile fact, not authority: the heads-up is recorded once.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.heads_up'", [pass.id]),
    ).toHaveLength(1);
  });

  it.each([
    { state: 'quarantined', mode: 'test' as const, set: 'test_data_quarantined=1' },
    { state: 'deleted', mode: 'live' as const, set: 'deleted_at=1' },
  ])(
    'does not finalize capacity_full when an occupant is $state before the fence',
    async ({ state, mode, set }) => {
      const event = await kit.event({ mode, templateIds: [tpl] });
      await run(kit.env.DB, 'UPDATE scan_events SET capacity=1 WHERE id=?', [event.id]);
      const scanner = await kit.scanner({ mode, eventId: event.id });
      const occupant = await kit.scanPass(tpl, {}, { mode });
      const next = await kit.scanPass(tpl, {}, { mode });
      expect((await out(await act(scanner.headers, codeOf(occupant)))).kind).toBe('ok');

      const response = await raceGate(
        scanner.headers,
        codeOf(next),
        (db) => run(db, `UPDATE passes SET ${set} WHERE id=?`, [occupant.id]),
        {},
        commitBatchSql,
      );
      // The occupancy moved under the commit: no stale capacity_full heads-up is recorded. A
      // quarantined occupant is a classified 409; a deleted one must not count as occupying at all.
      if (state === 'quarantined') {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'SCAN_IN_PROGRESS' });
      }
      expect(
        await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.heads_up'", [
          next.id,
        ]),
      ).toHaveLength(0);
    },
  );
}
