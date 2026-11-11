import { expect } from 'vitest';
import { all, first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';

export function missCounter(db: D1Database, key: string, window: number) {
  return first<{ count: number }>(db, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
    key,
    window,
  ]);
}

export function missAudits(db: D1Database, actorId: string) {
  return all(
    db,
    "SELECT * FROM audit_log WHERE action='scan.misses_capped' AND actor_id=? ORDER BY id",
    [actorId],
  );
}

/** Interpose after the pending claim is evaluated, immediately before its effect transaction. */
export async function atMissStopCommit(
  env: AppEnv,
  idempotencyKey: string,
  change: (db: D1Database, scanId: string) => Promise<unknown>,
  work: () => Promise<Response>,
): Promise<{ response: Response; scanId: string }> {
  const real = env.DB;
  const finalizes = new WeakSet<D1PreparedStatement>();
  let scanId: string | undefined;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          // Every stop commit opens its batch with the grant insert (the claim has its own grant).
          if (!sql.includes('INSERT INTO authority_grants')) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  if (!values.includes('org_mode.scan.claim')) finalizes.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!scanId && statements.some((statement) => finalizes.has(statement))) {
            const pending = await first<{ id: string; state: string }>(
              real,
              'SELECT id,state FROM scans WHERE idempotency_key=?',
              [idempotencyKey],
            );
            expect(pending?.state).toBe('pending');
            if (!pending) throw new Error('Missing pending claim');
            scanId = pending.id;
            await change(real, pending.id);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(env, { DB: db });
  try {
    const response = await work();
    if (!scanId) throw new Error('Miss finalization batch was not reached');
    return { response, scanId };
  } finally {
    Object.assign(env, { DB: real });
  }
}
