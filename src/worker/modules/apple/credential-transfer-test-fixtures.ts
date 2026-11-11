import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';

export async function beginTransfer(kit: Kit, pass: Pass) {
  const expected = await getHolderPass(kit.env.DB, pass.id, null);
  if (!expected) throw new Error('Missing holder transfer snapshot');
  return startCredentialTransfer(
    jobCtxOf(kit),
    { type: 'system', id: null },
    pass.id,
    { holderEmail: 'next-holder@example.test', ownerUserId: null },
    null,
    { kind: 'tenant-holder', expected },
  );
}

type Method = 'first' | 'all' | 'run' | 'batch';

/** Pause a real D1 operation at a precise statement boundary; the intervention uses the real DB. */
export function interveneAtD1(
  db: D1Database,
  options: { method: Method; sql: RegExp; when: 'before' | 'after'; occurrence?: number },
  intervene: () => Promise<void>,
): { db: D1Database; hits: () => number } {
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  const nativeOf = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let matches = 0;
  let hits = 0;
  async function execute<T>(method: Method, sql: string, operation: () => Promise<T>): Promise<T> {
    const selected =
      method === options.method && options.sql.test(sql) && ++matches === (options.occurrence ?? 1);
    if (selected) hits++;
    if (selected && options.when === 'before') await intervene();
    const result = await operation();
    if (selected && options.when === 'after') await intervene();
    return result;
  }
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === 'first')
          return (column?: string) =>
            execute(property, sql, () =>
              column === undefined ? target.first() : target.first(column),
            );
        if (property === 'all') return () => execute(property, sql, () => target.all());
        if (property === 'run') return () => execute(property, sql, () => target.run());
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    sqlOf.set(proxy, sql);
    nativeOf.set(proxy, statement);
    return proxy;
  };
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === 'batch')
        return (statements: D1PreparedStatement[]) => {
          const sql = statements.map((s) => sqlOf.get(s) ?? '').join('\n');
          return execute('batch', sql, () =>
            target.batch(statements.map((s) => nativeOf.get(s) ?? s)),
          );
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, hits: () => hits };
}
