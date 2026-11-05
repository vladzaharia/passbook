/** A D1 wrapper that counts round trips (a batch is one), for the SA 13.1 budgets. */
export interface CountedD1 {
  db: D1Database;
  /** Round trips since the last reset. */
  count(): number;
  /** The SQL text of each single statement run, in order. Batches list their statements too. */
  sql(): string[];
  reset(): void;
}

export function countD1(real: D1Database): CountedD1 {
  let trips = 0;
  let log: string[] = [];
  const wrapStatement = (st: D1PreparedStatement, text: string): D1PreparedStatement =>
    new Proxy(st, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'bind')
          return (...args: unknown[]) => wrapStatement(target.bind(...args), text);
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw')
          return (...args: unknown[]) => {
            trips++;
            log.push(text);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const texts = new WeakMap<D1PreparedStatement, string>();
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const wrapped = wrapStatement(target.prepare(sql), sql);
          texts.set(wrapped, sql);
          return wrapped;
        };
      if (prop === 'batch')
        return (statements: D1PreparedStatement[]) => {
          trips++;
          for (const s of statements) log.push(texts.get(s) ?? '?');
          return target.batch(statements);
        };
      if (prop === 'exec')
        return (sql: string) => {
          trips++;
          log.push(sql);
          return target.exec(sql);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    db,
    count: () => trips,
    sql: () => [...log],
    reset() {
      trips = 0;
      log = [];
    },
  };
}
