import { beforeAll, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import {
  codeOf,
  key,
  type ScanKit,
  setupScanKit,
  startScanCredentialTransfer,
} from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Credential and lifecycle gate fence', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

type Column = 'credential_generation' | 'lifecycle_generation';

/** Send one check-in, running `change` right before its gate batch. */
async function checkInRacing(pass: Pass, requestKey: string, change: Column | null) {
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const real = kit.env.DB;
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
          if (!fired && statements.some((statement) => gates.has(statement))) {
            fired = true;
            if (change === 'credential_generation')
              expect((await startScanCredentialTransfer(kit, pass.id, { db: real })).state).toBe(
                'completed',
              );
            else if (change === 'lifecycle_generation') {
              await run(real, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
              await run(real, "UPDATE passes SET status='active' WHERE id=?", [pass.id]);
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
      idempotencyKey: requestKey,
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(fired).toBe(true);
    return response;
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

it.each(['credential_generation', 'lifecycle_generation'] as const)(
  'refuses a changed pass %s before the gate transaction',
  async (column) => {
    const pass = await kit.scanPass(templateId);
    const original = await first<{ generation: number }>(
      kit.env.DB,
      `SELECT ${column} AS generation FROM passes WHERE id=?`,
      [pass.id],
    );
    if (!original) throw new Error('Missing pass generation');
    const requestKey = key();
    const response = await checkInRacing(pass, requestKey, column);
    // The grant pins both generations: a classified refusal that writes nothing.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_PASS_CHANGED' });
    const real = kit.env.DB;
    expect(
      await first(real, `SELECT ${column} AS generation FROM passes WHERE id=?`, [pass.id]),
    ).toEqual({ generation: original.generation + (column === 'credential_generation' ? 1 : 2) });
    const claim = await first<{ state: string; outcome: string | null; pass_id: string | null }>(
      real,
      'SELECT state,outcome,pass_id FROM scans WHERE idempotency_key=?',
      [requestKey],
    );
    expect(claim === null || (claim.state === 'failed' && claim.outcome === null)).toBe(true);
    expect(claim?.pass_id ?? null).toBeNull();
    expect(await effects(pass.id)).toEqual({ gates: [], presence: [], events: [] });
  },
);

it('admits the same check-in when no generation changes before the gate transaction', async () => {
  const pass = await kit.scanPass(templateId);
  const response = await checkInRacing(pass, key(), null);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ kind: 'ok' });
  expect((await effects(pass.id)).gates).toHaveLength(1);
});
