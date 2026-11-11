import type { ServiceContext } from '../../platform/service-context.ts';
import type { AssetGrantBatchResult } from './asset-grant-results.ts';

type Statement = { sql: string; params: unknown[] };
type Trip = { kind: 'single' | 'batch'; statements: Statement[] };
type BatchHook = (
  statements: Statement[],
  results: D1Result[],
) => Promise<AssetGrantBatchResult[]> | AssetGrantBatchResult[];

/** Trace real prepared statements while preserving the D1 transaction and ordered binds. */
export function traceLiveD1(real: D1Database, afterBatch?: BatchHook) {
  const trips: Trip[] = [];
  const wrapped = new WeakMap<
    D1PreparedStatement,
    { real: D1PreparedStatement; seen: Statement }
  >();
  const wrap = (statement: D1PreparedStatement, seen: Statement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind')
          return (...params: unknown[]) => wrap(target.bind(...params), { sql: seen.sql, params });
        const value = Reflect.get(target, property, target);
        if (property === 'first' || property === 'all' || property === 'run' || property === 'raw')
          return (...args: unknown[]) => {
            trips.push({ kind: 'single', statements: [seen] });
            return (value as (...values: unknown[]) => unknown).apply(target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    wrapped.set(proxy, { real: statement, seen });
    return proxy;
  };
  const db = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => wrap(target.prepare(sql), { sql, params: [] });
      if (property === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          const entries = batch.map((statement) => {
            const entry = wrapped.get(statement);
            if (!entry) throw new Error('Untraced D1 statement in batch.');
            return entry;
          });
          const seen = entries.map((entry) => entry.seen);
          trips.push({ kind: 'batch', statements: seen });
          const results = await target.batch(entries.map((entry) => entry.real));
          return afterBatch ? afterBatch(seen, results) : results;
        };
      if (property === 'exec')
        return (sql: string) => {
          trips.push({ kind: 'single', statements: [{ sql, params: [] }] });
          return target.exec(sql);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, trips };
}

export const photoAcquisition = (statements: Statement[]) =>
  statements.some(({ sql }) => sql.includes('SELECT * FROM member_photos')) &&
  statements.some(({ sql }) => sql.includes('FROM scan_asset_grant_provenance'));

export const grantInsertion = (statements: Statement[]) =>
  statements.some(({ sql }) => sql.includes('asset_grant_final')) &&
  statements.some(({ sql }) => sql.includes('INTO scan_asset_grant_provenance'));

export function contextWithDb(ctx: ServiceContext, db: D1Database): ServiceContext {
  return { ...ctx, env: { ...ctx.env, DB: db } };
}
