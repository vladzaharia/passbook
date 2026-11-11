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
          if (
            sql.includes(' AS result_0') &&
            (sql.includes('json_group_array') ||
              sql.includes('output_bound_snapshot') ||
              sql.includes('output_segments'))
          )
            return wrap(statement);
          if (
            !sql.includes(' AS authorized') ||
            (!sql.includes('output_bound_snapshot') && !sql.includes('output_segments'))
          )
            return statement;
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
