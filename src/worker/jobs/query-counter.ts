import type { AppEnv } from '../platform/env.ts';

/** D1 allows 1,000 queries per invocation; the daily hooks stop starting new work below this. */
export const CRON_QUERY_BUDGET = 900;

export interface QueryCounter {
  env: AppEnv;
  count(): number;
}

/** An env whose DB counts the queries run through it (a batch counts as one, like D1 does). */
export function countQueries(env: AppEnv): QueryCounter {
  let queries = 0;
  const raw = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') {
          return (...args: unknown[]) => wrap(target.bind(...args));
        }
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
          return (...args: unknown[]) => {
            queries++;
            return (target[prop] as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    raw.set(wrapped, statement);
    return wrapped;
  };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          queries++;
          return target.batch(statements.map((s) => raw.get(s) ?? s));
        };
      }
      if (prop === 'exec') {
        return (sql: string) => {
          queries++;
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const counted = Object.create(env) as AppEnv;
  Object.defineProperty(counted, 'DB', { value: db, enumerable: true });
  return { env: counted, count: () => queries };
}
