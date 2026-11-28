/* Test-only: run a mutation on the real database just before a matching batch executes. */
/** Runs `mutate` on the real database once, just before the first batch holding a statement that matches. */
export async function beforeBatch<T>(
  env: { DB: D1Database },
  match: RegExp | string,
  mutate: (db: D1Database) => Promise<unknown>,
  call: () => Promise<T>,
): Promise<{ result: T; fired: boolean }> {
  const original = env.DB;
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  const matches = (sql: string) =>
    typeof match === 'string' ? sql.includes(match) : match.test(sql);
  let fired = false;
  const matches = (sql: string) =>
    typeof match === 'string' ? sql.includes(match) : match.test(sql);
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
          if (!fired && statements.some((st) => matches(sqlOf.get(st) ?? ''))) {
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

/** Runs `mutate` on the real database once, just after the first batch holding a statement that matches. */
export async function afterBatch<T>(
  env: { DB: D1Database },
  match: RegExp,
  mutate: (db: D1Database) => Promise<unknown>,
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
          const results = await target.batch(statements);
          if (!fired && statements.some((st) => match.test(sqlOf.get(st) ?? ''))) {
            fired = true;
            await mutate(original);
          }
          return results;
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

/** Runs `mutate` on the real database once, just before the first single statement that matches reads. */
export async function beforeStatement<T>(
  env: { DB: D1Database },
  match: RegExp,
  mutate: (db: D1Database) => Promise<unknown>,
  call: () => Promise<T>,
): Promise<{ result: T; fired: boolean }> {
  const original = env.DB;
  let fired = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, member) {
        if (member === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, member, target);
        if ((member === 'all' || member === 'first') && match.test(sql))
          return async (...args: unknown[]) => {
            if (!fired) {
              fired = true;
              await mutate(original);
            }
            return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  env.DB = new Proxy(original, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
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
