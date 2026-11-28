/* Test-only: count the sequential D1 round trips of a piece of work. */
/**
 * Sequential D1 round trips after the first statement that matches `from`: a call that starts while
 * another is in flight rides the same trip. `calls` counts every statement call, a batch as one.
 */
export async function tripsFrom(
  env: { DB: D1Database },
  from: RegExp | string,
  work: () => Promise<unknown>,
) {
  const real = env.DB;
  const texts = new WeakMap<D1PreparedStatement, string>();
  const reals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let inflight = 0;
  let started = false;
  let trips = 0;
  let calls = 0;
  const begin = (sql: string) => {
    if (!started && (typeof from === 'string' ? sql.includes(from) : from.test(sql)))
      started = true;
    if (!started) return false;
    if (inflight === 0) trips++;
    inflight++;
    calls++;
    return true;
  };
  const run = <T>(sql: string, call: () => Promise<T>): Promise<T> => {
    const counted = begin(sql);
    return call().finally(() => {
      if (counted) inflight--;
    });
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, member) {
        const value = Reflect.get(target, member, target);
        if (member === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (member === 'first' || member === 'all' || member === 'run' || member === 'raw')
          return (...args: unknown[]) =>
            run(sql, () => (value as (...a: unknown[]) => Promise<never>).apply(target, args));
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    texts.set(proxy, sql);
    reals.set(proxy, statement);
    return proxy;
  };
  env.DB = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === 'batch')
        return (statements: D1PreparedStatement[]) =>
          run(statements.map((s) => texts.get(s) ?? '').join('\n'), () =>
            target.batch(statements.map((s) => reals.get(s) ?? s)),
          );
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await work();
  } finally {
    env.DB = real;
  }
  return { trips, calls };
}
