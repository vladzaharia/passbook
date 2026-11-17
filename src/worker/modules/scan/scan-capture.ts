import { type AfterRead, afterRead } from '../../platform/authority-after.ts';
import { AuthorityError } from '../../platform/authority-error.ts';
import { mapOutsideLiterals } from '../../platform/authority-sqltext.ts';
import type { SqlValue } from '../../platform/db.ts';

interface Captured {
  sql: string;
  params: SqlValue[];
}

const captured = new WeakMap<object, Captured>();
const capturing = new WeakSet<object>();

/**
 * A database whose bound statements remember their SQL and values. Side builders (counts, history,
 * photo grants, proofs, refunds) return prepared statements; a grant batch takes SQL and values, so
 * they are built against this handle and re-issued inside the grant (`scan-write-grant.ts`).
 */
export function capturingDb(db: D1Database): D1Database {
  if (capturing.has(db)) return db;
  const proxy = new Proxy(db, {
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
  capturing.add(proxy);
  return proxy;
}

export function capturedStatement(statement: D1PreparedStatement): Captured | undefined {
  return captured.get(statement);
}

// A bind label (`?/* scan-ephemeral-x */`) only names its placeholder for packing; it is not SQL.
const BIND_LABEL = /\/\*\s*scan-ephemeral-[a-z0-9:-]*\s*\*\//g;

/** Captured reads re-issued after a grant's release (`Grant.commitWith`); a write is refused there. */
export function afterReads(statements: readonly D1PreparedStatement[]): AfterRead[] {
  return statements.map((statement) => {
    const seen = captured.get(statement);
    if (!seen)
      throw new AuthorityError('GRANT_FOREIGN_STATEMENT', 'A read after a grant was not captured.');
    return afterRead(
      mapOutsideLiterals(seen.sql, (text) => text.replace(BIND_LABEL, '')),
      seen.params,
    );
  });
}
