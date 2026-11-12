import { beforeAll, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { commitBatchSql } from './repo-act-support-test-fixtures.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Pending gate claim', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

/** Run `change` right before the first batch whose grant has this purpose. */
async function racePurpose<T>(
  purpose: string,
  change: (db: D1Database) => Promise<unknown>,
  work: () => Promise<T>,
): Promise<T> {
  const real = kit.env.DB;
  const marked = new WeakSet<D1PreparedStatement>();
  let fired = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes(commitBatchSql)) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  if (values.includes(purpose)) marked.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((statement) => marked.has(statement))) {
            fired = true;
            await change(real);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const result = await work();
    expect(fired).toBe(true);
    return result;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

const effects = async (passId: string) => ({
  gates: await all(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id=?', [passId]),
  presence: await all(kit.env.DB, 'SELECT * FROM scan_presence WHERE pass_id=?', [passId]),
  events: await all(
    kit.env.DB,
    "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
    [passId],
  ),
});

it('claims only under the original scanner credential', async () => {
  const pass = await kit.scanPass(templateId);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const request = (idempotencyKey: string) =>
    kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey,
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
  const revokedKey = key();
  const response = await racePurpose(
    'org_mode.scan.claim',
    (db) => run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), scanner.id]),
    () => request(revokedKey),
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: 'SCANNER_REPAIR' });
  expect(
    await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [revokedKey]),
  ).toBeNull();
  // The same request from a live scanner claims and commits.
  const live = await kit.scanner({ templateIds: [templateId] });
  const ok = await kit.post(live.headers, '/actions', {
    input: codeOf(pass),
    idempotencyKey: key(),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ kind: 'ok' });
});

// The commit finalizes only the claim generation it owns (id, pending, at). A generation reopened
// or failed by recovery in the meantime refuses the whole batch: nothing is half written.
it.each([
  ['reopened as a new generation', 'UPDATE scans SET at=at+1 WHERE idempotency_key=?'],
  ['failed by recovery', "UPDATE scans SET state='failed' WHERE idempotency_key=?"],
])('refuses a claim %s before the gate transaction', async (_label, change) => {
  const pass = await kit.scanPass(templateId);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const idempotencyKey = key();
  const response = await racePurpose(
    'org_mode.scan.check_in',
    (db) => run(db, change, [idempotencyKey]),
    () =>
      kit.post(scanner.headers, '/actions', {
        input: codeOf(pass),
        idempotencyKey,
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'SCAN_IN_PROGRESS' });
  expect(
    await first(kit.env.DB, 'SELECT outcome,pass_id FROM scans WHERE idempotency_key=?', [
      idempotencyKey,
    ]),
  ).toEqual({ outcome: null, pass_id: null });
  expect(await effects(pass.id)).toEqual({ gates: [], presence: [], events: [] });
});

it('refuses a moved claim generation before a held-gate result is finalized', async () => {
  const once = await kit.scanTemplate('Held claim', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'once' }],
  });
  const pass = await kit.scanPass(once);
  const scanner = await kit.scanner({ templateIds: [once] });
  const request = (idempotencyKey: string) =>
    kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey,
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
  expect(await (await request(key())).json()).toMatchObject({ kind: 'ok' });
  const original = await effects(pass.id);
  const idempotencyKey = key();
  const response = await racePurpose(
    'org_mode.scan.held',
    (db) => run(db, 'UPDATE scans SET at=at+1 WHERE idempotency_key=?', [idempotencyKey]),
    () => request(idempotencyKey),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'SCAN_IN_PROGRESS' });
  expect(
    await first(kit.env.DB, 'SELECT outcome,pass_id FROM scans WHERE idempotency_key=?', [
      idempotencyKey,
    ]),
  ).toEqual({ outcome: null, pass_id: null });
  expect(await effects(pass.id)).toEqual(original);
  // Positive control: the same held scan with its generation intact records the heads-up.
  expect(await (await request(key())).json()).toMatchObject({
    kind: 'heads_up',
    reason: 'already_done',
  });
});
