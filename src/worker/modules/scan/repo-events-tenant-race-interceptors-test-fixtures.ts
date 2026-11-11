import { expect } from 'vitest';
import type { AppEnv } from '../../platform/env.ts';

export function createEventTenantRaceInterceptors(getEnv: () => AppEnv) {
  /** Intervene before bootstrap/commit, or after the committing transaction has completed. */
  async function atEventCommit(
    intervene: (db: D1Database) => Promise<void>,
    operation: () => Promise<Response>,
    phase: 'commit' | 'bootstrap' | 'after-commit' = 'commit',
  ) {
    const env = getEnv();
    const real = env.DB;
    const sqlOf = new WeakMap<D1PreparedStatement, string>();
    let hits = 0;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(prepared, member) {
                if (member === 'bind') {
                  return (...values: unknown[]) => {
                    const bound = prepared.bind(...values);
                    sqlOf.set(bound, sql);
                    return bound;
                  };
                }
                const value = Reflect.get(prepared, member, prepared);
                return typeof value === 'function' ? value.bind(prepared) : value;
              },
            });
          };
        }
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const targetWrite = statements.some((statement) => {
              const sql = sqlOf.get(statement) ?? '';
              return (
                /\b(?:INSERT(?: OR IGNORE)? INTO|UPDATE) (?:scan_events|scanners)\b/i.test(sql) ||
                /\bscanning_config_revisions\b/i.test(sql)
              );
            });
            const bootstrap = statements.some((statement) =>
              /\bINSERT\s+INTO\s+credential_ref_keyset\b/i.test(sqlOf.get(statement) ?? ''),
            );
            if (
              !hits &&
              phase !== 'after-commit' &&
              (phase === 'bootstrap' ? bootstrap : targetWrite)
            ) {
              hits++;
              await intervene(real);
            }
            const result = await target.batch(statements);
            if (!hits && phase === 'after-commit' && targetWrite) {
              hits++;
              await intervene(real);
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(env, { DB: db });
    try {
      const response = await operation();
      expect(hits).toBe(1);
      return response;
    } finally {
      Object.assign(env, { DB: real });
    }
  }

  /** Intervene around the target or event read, or before its guarded cache update. */
  async function atEventRead(
    kind: 'detail' | 'list',
    phase: 'target' | 'before-row' | 'row' | 'cache',
    intervene: (db: D1Database) => Promise<void>,
    operation: () => Promise<Response>,
  ) {
    const env = getEnv();
    const real = env.DB;
    let matches = 0;
    let intercepted = 0;
    const underlying = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const sqlOf = new WeakMap<D1PreparedStatement, string>();
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const wrapped = new Proxy(statement, {
        get(target, prop) {
          if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
          const value = Reflect.get(target, prop, target);
          const method = kind === 'detail' ? 'first' : 'all';
          const rowRead =
            (phase === 'row' || phase === 'before-row') &&
            prop === method &&
            /\bFROM\s+scan_events\s+e\b/i.test(sql);
          const targetRead =
            phase === 'target' &&
            prop === 'first' &&
            /\bSELECT\s+org_id\s+AS\s+orgId,\s*mode\s+FROM\s+scan_events\s+WHERE\s+id/i.test(sql);
          const cacheWrite =
            phase === 'cache' &&
            prop === 'run' &&
            /\bUPDATE\s+scan_events\b[\s\S]*\bSET\s+expected\s*=/i.test(sql);
          if (rowRead || targetRead || cacheWrite) {
            return async (...values: unknown[]) => {
              if ((cacheWrite || (rowRead && phase === 'before-row')) && !intercepted) {
                intercepted++;
                await intervene(real);
              }
              const result = await (value as (...args: unknown[]) => Promise<unknown>).apply(
                target,
                values,
              );
              if ((rowRead && phase === 'row') || targetRead) {
                matches++;
                if (matches === 1) {
                  intercepted++;
                  await intervene(real);
                }
              }
              return result;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      underlying.set(wrapped, statement);
      sqlOf.set(wrapped, sql);
      return wrapped;
    };
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const rowRead =
              (phase === 'row' || phase === 'before-row') &&
              statements.some((statement) =>
                /\bFROM\s+scan_events\s+e\b/i.test(sqlOf.get(statement) ?? ''),
              );
            if (rowRead && phase === 'before-row' && !intercepted) {
              intercepted++;
              await intervene(real);
            }
            // The cache fill is a grant batch: intervene before it commits.
            const cacheWrite =
              phase === 'cache' &&
              statements.some((statement) =>
                /\bUPDATE\s+scan_events\b[\s\S]*\bSET\s+expected\s*=/i.test(
                  sqlOf.get(statement) ?? '',
                ),
              );
            if (cacheWrite && !intercepted) {
              intercepted++;
              await intervene(real);
            }
            const result = await target.batch(
              statements.map((statement) => underlying.get(statement) ?? statement),
            );
            if (rowRead && phase === 'row' && !intercepted) {
              intercepted++;
              await intervene(real);
            }
            return result;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(env, { DB: db });
    try {
      const response = await operation();
      expect(intercepted).toBe(1);
      return response;
    } finally {
      Object.assign(env, { DB: real });
    }
  }

  return { atEventCommit, atEventRead };
}
