import type { SqlValue } from '../../platform/db.ts';

interface Captured {
  sql: string;
  params: SqlValue[];
}

const captured = new WeakMap<object, Captured>();

/**
 * A database whose bound statements remember their SQL and values. Side builders (counts, history,
 * photo grants, proofs, refunds) return prepared statements; a grant batch takes SQL and values, so
 * they are built against this handle and re-issued inside the grant (`scan-write-grant.ts`).
 */
export function capturingDb(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql: string) => {
        const prepared = target.prepare(sql);
        return new Proxy(prepared, {
          get(statement, member) {
            if (member === 'bind')
              return (...values: SqlValue[]) => {
                const bound = statement.bind(...values);
                captured.set(bound, { sql, params: values });
                return bound;
              };
            const value = Reflect.get(statement, member, statement);
            return typeof value === 'function' ? value.bind(statement) : value;
          },
        });
      };
    },
  });
}

export function capturedStatement(statement: D1PreparedStatement): Captured | undefined {
  return captured.get(statement);
}
