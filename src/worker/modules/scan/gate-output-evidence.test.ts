import { beforeAll, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Committed evidence fence', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    display: {
      v: 1,
      header: {},
      variants: [
        {
          id: 'returning',
          name: 'Returning',
          when: { path: 'history.scans.total', gte: 1 },
          header: { title: 'Previous scan' },
        },
      ],
    },
  });
});

it.each(['event', 'retention', 'gate', 'request hash', 'scanner csrf'] as const)(
  'withholds the committed response when its %s changes before final display authorization',
  async (changed) => {
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const real = kit.env.DB;
    const finalReads = new WeakSet<D1PreparedStatement>();
    let fired = false;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            if (!sql.includes('AS authorized') || !sql.includes('scan_retention_proofs'))
              return prepared;
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = statement.bind(...values);
                    finalReads.add(bound);
                    return bound;
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!fired && statements.some((statement) => finalReads.has(statement))) {
              const scan = await first<{ id: string }>(
                real,
                "SELECT id FROM scans WHERE pass_id=? AND state='done' AND outcome='ok'",
                [pass.id],
              );
              if (scan) {
                fired = true;
                if (changed === 'event')
                  await run(
                    real,
                    "UPDATE pass_events SET data=json_set(data,'$.outcome','heads_up') WHERE pass_id=?",
                    [pass.id],
                  );
                else if (changed === 'retention')
                  await run(
                    real,
                    'UPDATE scan_retention_proofs SET invalidated=1 WHERE scan_id=?',
                    [scan.id],
                  );
                else if (changed === 'request hash')
                  await run(
                    real,
                    "UPDATE scans SET request_hash='changed-after-commit' WHERE id=?",
                    [scan.id],
                  );
                else if (changed === 'scanner csrf')
                  await run(
                    real,
                    'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
                    ['rotated-csrf-fixture', scanner.id],
                  );
                else
                  await run(real, 'UPDATE scan_gates SET count=count+1 WHERE pass_id=?', [pass.id]);
              }
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    try {
      const response = await kit.post(scanner.headers, '/actions', {
        input: codeOf(pass),
        idempotencyKey: key(),
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      });
      expect(fired).toBe(true);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'SCAN_UNCONFIRMED' });
    } finally {
      Object.assign(kit.env, { DB: real });
    }
    expect(
      await all(real, "SELECT id FROM scans WHERE pass_id=? AND state='done' AND outcome='ok'", [
        pass.id,
      ]),
    ).toHaveLength(1);
    expect(await all(real, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(1);
    expect(
      await all(real, "SELECT * FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'", [
        pass.id,
      ]),
    ).toHaveLength(1);
  },
);

it('withholds an unconfirmed no-history display while preserving the atomic committed scan', async () => {
  const template = await kit.scanTemplate('Atomic no-history display', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
  const pass = await kit.scanPass(template);
  const scanner = await kit.scanner({ templateIds: [template] });
  const real = kit.env.DB;
  const gates = new WeakSet<D1PreparedStatement>();
  const outputs = new WeakSet<D1PreparedStatement>();
  let fired = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          const selected = sql.includes('INSERT INTO scan_gates')
            ? gates
            : sql.includes('AS authorized') && sql.includes('scan_retention_proofs')
              ? outputs
              : null;
          if (!selected) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  selected.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (
            !fired &&
            statements.some((statement) => gates.has(statement)) &&
            statements.some((statement) => outputs.has(statement))
          ) {
            fired = true;
            return target.batch(
              statements.map((statement) =>
                outputs.has(statement)
                  ? target.prepare('SELECT 0 AS authorized').bind()
                  : statement,
              ),
            );
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const response = await kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(fired).toBe(true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_UNCONFIRMED' });
  } finally {
    Object.assign(kit.env, { DB: real });
  }
  expect(
    await all(real, "SELECT id FROM scans WHERE pass_id=? AND state='done' AND outcome='ok'", [
      pass.id,
    ]),
  ).toHaveLength(1);
  expect(
    await all(real, "SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'", [
      pass.id,
    ]),
  ).toHaveLength(1);
});

it.each(['gate', 'claim'] as const)(
  'rolls back an already-held gate when its %s changes after the upsert',
  async (changed) => {
    const template = await kit.scanTemplate('Atomic repeat gate', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner({ templateIds: [template] });
    const request = (idempotencyKey: string) =>
      kit.post(scanner.headers, '/actions', {
        input: codeOf(pass),
        idempotencyKey,
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      });
    const firstResponse = await request(key());
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toMatchObject({ kind: 'ok' });

    const real = kit.env.DB;
    const originalGate = await all(real, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id]);
    const originalPresence = await all(real, 'SELECT * FROM scan_presence WHERE pass_id=?', [
      pass.id,
    ]);
    const originalScans = await all(real, 'SELECT * FROM scans WHERE pass_id=? ORDER BY id', [
      pass.id,
    ]);
    const originalEvents = await all(
      real,
      "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%' ORDER BY id",
      [pass.id],
    );
    const proofSql = `SELECT proof.* FROM scan_retention_proofs proof
      JOIN scans s ON s.id=proof.scan_id WHERE s.pass_id=? ORDER BY proof.scan_id`;
    const originalProofs = await all(real, proofSql, [pass.id]);
    expect(originalGate).toHaveLength(1);
    expect(originalEvents).toHaveLength(1);
    expect(originalProofs).toHaveLength(1);

    const idempotencyKey = key();
    const gates = new WeakSet<D1PreparedStatement>();
    let fired = false;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            if (!sql.includes('INSERT INTO scan_gates')) return prepared;
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = statement.bind(...values);
                    gates.add(bound);
                    return bound;
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const index = statements.findIndex((statement) => gates.has(statement));
            if (!fired && index >= 0) {
              fired = true;
              const mutation =
                changed === 'gate'
                  ? target
                      .prepare('UPDATE scan_gates SET count=count+1 WHERE pass_id=?')
                      .bind(pass.id)
                  : target
                      .prepare(
                        "UPDATE scans SET request_hash='changed-in-batch' WHERE idempotency_key=?",
                      )
                      .bind(idempotencyKey);
              return target.batch([
                ...statements.slice(0, index + 1),
                mutation,
                ...statements.slice(index + 1),
              ]);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    try {
      const response = await request(idempotencyKey);
      expect(fired).toBe(true);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ kind: 'refused', reason: 'not_found' });
    } finally {
      Object.assign(kit.env, { DB: real });
    }

    expect(await all(real, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id])).toEqual(
      originalGate,
    );
    expect(await all(real, 'SELECT * FROM scan_presence WHERE pass_id=?', [pass.id])).toEqual(
      originalPresence,
    );
    expect(await all(real, 'SELECT * FROM scans WHERE pass_id=? ORDER BY id', [pass.id])).toEqual(
      originalScans,
    );
    expect(
      await all(
        real,
        "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%' ORDER BY id",
        [pass.id],
      ),
    ).toEqual(originalEvents);
    expect(await all(real, proofSql, [pass.id])).toEqual(originalProofs);
    expect(
      await all(
        real,
        `SELECT * FROM scan_retention_proofs
          WHERE scan_id IN (SELECT id FROM scans WHERE idempotency_key=?)`,
        [idempotencyKey],
      ),
    ).toHaveLength(0);
    expect(
      await first(real, 'SELECT state,reason,pass_id FROM scans WHERE idempotency_key=?', [
        idempotencyKey,
      ]),
    ).toEqual({ state: 'failed', reason: 'stale', pass_id: null });
  },
);
