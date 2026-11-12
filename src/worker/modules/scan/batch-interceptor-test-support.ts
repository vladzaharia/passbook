/* Test-only: run a mutation on the real database just before a matching batch executes. */
/** Runs `mutate` on the real database once, just before the first batch holding a statement that matches. */
export async function beforeBatch<T>(
  env: { DB: D1Database },
  match: RegExp,
  mutate: (db: D1Database) => Promise<void>,
  call: () => Promise<T>,
): Promise<{ result: T; fired: boolean }> {
  const original = env.DB;
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  let fired = false;
  env.DB = new Proxy(original, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) =>
          new Proxy(target.prepare(sql), {
            get(inner, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  sqlOf.set(bound, sql);
                  return bound;
                };
              const value = Reflect.get(inner, member, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((st) => match.test(sqlOf.get(st) ?? ''))) {
            fired = true;
            await mutate(original);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    return { result: await call(), fired };
  } finally {
    env.DB = original;
  }
}
