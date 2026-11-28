import {
  RACE_KEYSET,
  RACE_PASS_OK,
  RACE_PASSLESS_READ,
  RACE_PREDICATE_AUTHORIZED,
} from './race-tags.ts';

/**
 * Triggers `change` ahead of the statements that decide what an answer discloses: the output fence's
 * history bind (a packed authority term), the passless read (`SELECT 1 AS ok FROM actor_ok`, run on
 * its own), and a lookup's two batches (the first search's gate, `AS keyset`, and the final pass read,
 * `AS pass_ok`).
 */
export function outputRaceDatabase(real: D1Database, trigger: () => Promise<void>) {
  const batchStatements = new WeakSet<D1PreparedStatement>();
  const unwrapped = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind')
          return (...values: unknown[]) => {
            const bound = wrap(target.bind(...values));
            batchStatements.add(bound);
            return bound;
          };
        if (prop === 'first')
          return async (column?: string) => {
            await trigger();
            return column === undefined ? target.first() : target.first(column);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    unwrapped.set(proxy, statement);
    return proxy;
  };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (sql.includes(RACE_PASSLESS_READ)) return wrap(statement);
          if (sql.includes(RACE_KEYSET) || sql.includes(RACE_PASS_OK))
            return new Proxy(statement, {
              get(inner, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = inner.bind(...values);
                    batchStatements.add(bound);
                    return bound;
                  };
                const value = Reflect.get(inner, member, inner);
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
          if (!sql.includes(RACE_PREDICATE_AUTHORIZED)) return statement;
          return new Proxy(statement, {
            get(inner, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  batchStatements.add(bound);
                  return bound;
                };
              const value = Reflect.get(inner, member, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((statement) => batchStatements.has(statement))) await trigger();
          return target.batch(statements.map((statement) => unwrapped.get(statement) ?? statement));
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return db;
}
