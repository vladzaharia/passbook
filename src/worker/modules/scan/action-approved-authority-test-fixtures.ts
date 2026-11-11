import { expect } from 'vitest';
import { first } from '../../platform/db.ts';
import type { ActionRequest, Scenario } from './action-gate-stale-budget-core-test-fixtures.ts';
import { effects } from './action-gate-stale-budget-core-test-fixtures.ts';
import { commitBatchSql } from './repo-act-support-test-fixtures.ts';
import { pinCounts, seedPinCounter } from './repo-action-gate-stale-budget-test-fixtures.ts';
import { PIN_PERSON_WINDOW_MS, PIN_SCANNER_WINDOW_MS } from './staff-pin.ts';

export type Refusal =
  | 'SCAN_CONFIG_CHANGED'
  | 'SCAN_STAFF_CHANGED'
  | 'SCAN_PASS_CHANGED'
  | 'SCANNER_REPAIR'
  | 'ACTOR_CHANGED'
  | 'ORG_ACCESS_CHANGED';

const STATUS: Record<Refusal, number> = {
  SCAN_CONFIG_CHANGED: 409,
  SCAN_STAFF_CHANGED: 409,
  SCAN_PASS_CHANGED: 409,
  SCANNER_REPAIR: 401,
  ACTOR_CHANGED: 403,
  ORG_ACCESS_CHANGED: 403,
};

/**
 * Seed the PIN counters at one below the reservation, run the approved action, and apply `mutate`
 * after evaluation but immediately before the commit batch (the one that opens with the grant row).
 */
export async function raceApproved(
  s: Scenario,
  body: ActionRequest,
  mutate: (db: D1Database) => Promise<unknown>,
): Promise<{ response: Response; before: Awaited<ReturnType<typeof effects>>; now: number }> {
  const real = s.kit.env.DB;
  const now = s.kit.clock.now();
  for (const [name, size, value] of [
    [`scan:pin:${s.scanner.id}:${s.manager.id}`, PIN_PERSON_WINDOW_MS, 2],
    [`scan:pinall:${s.scanner.id}`, PIN_SCANNER_WINDOW_MS, 3],
  ] as const)
    await seedPinCounter(real, name, now - (now % size), value);
  const grantStatements = new WeakSet<D1PreparedStatement>();
  let raced = false;
  let before: Awaited<ReturnType<typeof effects>> | undefined;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes(commitBatchSql)) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...params: unknown[]) => {
                  const bound = statement.bind(...params);
                  // The claim batch also opens with a grant; the race belongs to the commit that follows.
                  if (!params.includes('org_mode.scan.claim')) grantStatements.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!raced && statements.some((statement) => grantStatements.has(statement))) {
            raced = true;
            await mutate(target);
            before = await effects(target, s);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(s.kit.env, { DB: db });
  try {
    const response = await s.post(body);
    expect(raced).toBe(true);
    if (!before) throw new Error('Missing interleaved snapshot');
    return { response, before, now };
  } finally {
    Object.assign(s.kit.env, { DB: real });
  }
}

/** A classified refusal: nothing is written, the PIN guess is refunded and the same key is retryable. */
export async function expectRefused(
  s: Scenario,
  body: ActionRequest,
  run: Awaited<ReturnType<typeof raceApproved>>,
  code: Refusal,
) {
  const json = (await run.response.json()) as { code?: string };
  expect(`${run.response.status} ${json.code}`).toBe(`${STATUS[code]} ${code}`);
  expect(JSON.stringify(json)).not.toContain(s.pass.id);
  expect(await effects(s.kit.env.DB, s)).toEqual(run.before);
  expect(await pinCounts(s.kit.env.DB, s, run.now)).toEqual({ person: 2, scanner: 3 });
  const claim = await first<{ state: string; outcome: string | null }>(
    s.kit.env.DB,
    'SELECT state,outcome FROM scans WHERE idempotency_key=?',
    [body.idempotencyKey],
  );
  expect(claim === null || (claim.state === 'failed' && claim.outcome === null)).toBe(true);
}
