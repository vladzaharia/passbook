import type { AppEnv } from '../../src/worker/platform/env.ts';

interface StepDouble {
  do(name: string, ...rest: never[]): Promise<unknown>;
}

const WRITE = /^\s*(insert|update|delete|replace)\b/i;

/**
 * Workflow code must write only inside step callbacks: anything outside re-runs on replay.
 * `env` proxies DB and records every write statement made while no step callback is active.
 */
export function guardWrites(base: AppEnv): {
  env: AppEnv;
  violations: string[];
  step<S extends object>(inner: S): S;
} {
  const violations: string[] = [];
  let depth = 0;
  const guardStatement = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...a: unknown[]) => guardStatement(target.bind(...a), sql);
        if (
          (prop === 'run' || prop === 'first' || prop === 'all') &&
          WRITE.test(sql) &&
          depth === 0
        ) {
          violations.push(sql.trim().slice(0, 80));
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const db = new Proxy(base.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => guardStatement(target.prepare(sql), sql);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env = Object.create(base) as AppEnv;
  Object.defineProperty(env, 'DB', { value: db, enumerable: true });
  return {
    env,
    violations,
    step: <S extends object>(inner: S): S => {
      const target = inner as unknown as StepDouble;
      return {
        ...inner,
        do: async (name: string, ...rest: never[]) => {
          depth++;
          try {
            return await target.do(name, ...rest);
          } finally {
            depth--;
          }
        },
      };
    },
  };
}
