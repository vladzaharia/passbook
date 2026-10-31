/** D1 allows 1,000 queries per invocation (a batch counts as one); keep a margin for handlers. */
export const QUEUE_QUERY_BUDGET = 800;

export interface QueryCounter {
  used: number;
}

const COUNTED = new Set(['first', 'all', 'run', 'raw']);

/**
 * Wraps a D1 binding so every query bumps `counter`. Statements are unwrapped again before
 * `batch`, which counts once like D1 does.
 */
export function countQueries(db: D1Database, counter: QueryCounter): D1Database {
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind')
          return (...values: unknown[]) => wrap(target.bind(...(values as [unknown])));
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (typeof prop === 'string' && COUNTED.has(prop))
          return (...args: unknown[]) => {
            counter.used++;
            return value.apply(target, args);
          };
        return value.bind(target);
      },
    });
    inner.set(proxy, statement);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'batch')
        return (statements: D1PreparedStatement[]) => {
          counter.used++;
          return target.batch(statements.map((s) => inner.get(s) ?? s));
        };
      if (prop === 'exec')
        return (sql: string) => {
          counter.used++;
          return target.exec(sql);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
