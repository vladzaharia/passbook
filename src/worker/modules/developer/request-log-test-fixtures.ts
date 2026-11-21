import { vi } from 'vitest';
import { all } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { ORIGIN, tryKit } from './try-token-test-fixtures.ts';

export type Kit = Awaited<ReturnType<typeof tryKit>>;
export { ORIGIN };

/** A kit whose requests run with an execution context that remembers its `waitUntil` promises. */
export async function logKit() {
  const t = await tryKit();
  const pending: Promise<unknown>[] = [];
  const ectx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  /** A call under `/api/v1`; `env` may carry a wrapped DB. */
  const call = (path: string, init: RequestInit = {}, env = t.kit.env) =>
    t.app.request(`${ORIGIN}/api/v1${path}`, init, env, ectx);
  /** Waits for every background write the calls made. */
  const settle = async () => {
    await Promise.all(pending.splice(0));
  };
  const rows = (orgId: string) =>
    all<Record<string, unknown>>(
      t.kit.env.DB,
      'SELECT * FROM request_log WHERE org_id = ? ORDER BY id',
      [orgId],
    );
  const ctx = () => createServiceContext(t.kit.env, { clock: t.kit.clock });
  return { ...t, call, settle, rows, ctx, unstub: () => vi.unstubAllGlobals() };
}

/** `db` with each statement's SQL recorded, and `INSERT INTO request_log` held until `gate` opens. */
export function gatedDb(db: D1Database, gate: Promise<void>, sql: string[]): D1Database {
  const bound = <T extends object>(target: T) =>
    new Proxy(target, {
      get(t, p) {
        const v = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'prepare') return bound(target)[prop as keyof D1Database];
      return (text: string) => {
        sql.push(text);
        const stmt = target.prepare(text);
        if (!text.includes('INSERT INTO request_log')) return stmt;
        return new Proxy(stmt, {
          get(s, p) {
            if (p !== 'bind') return bound(s)[p as keyof D1PreparedStatement];
            return (...args: unknown[]) =>
              new Proxy(s.bind(...args), {
                get(b, bp) {
                  if (bp === 'run')
                    return async () => {
                      await gate;
                      return b.run();
                    };
                  return bound(b)[bp as keyof D1PreparedStatement];
                },
              });
          },
        });
      };
    },
  });
}
